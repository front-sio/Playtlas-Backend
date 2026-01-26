const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const { RevenueAggregator } = require('./RevenueAggregator');
const { AgentContributionCalculator } = require('./AgentContributionCalculator');

const prisma = new PrismaClient();

/**
 * EarningsService - Manages agent earnings calculations and distribution
 * 
 * Implements hybrid compensation model:
 * - Base Pay (fixed daily amount)
 * - Revenue Share (percentage of platform fees)
 * - Bonuses (uptime, attendance, quality)
 */
class EarningsService {

  constructor() {
    this.revenueAggregator = new RevenueAggregator();
    this.contributionCalculator = new AgentContributionCalculator();
  }

  /**
   * Compute daily earnings for all agents in a club
   */
  async computeDailyEarnings(clubId, date, userId = null) {
    const dateStr = date instanceof Date ? date.toISOString().split('T')[0] : date;

    logger.info({
      clubId,
      date: dateStr,
      triggeredBy: userId
    }, '[EarningsService] Starting daily earnings computation');

    try {
      // Step 1: Aggregate revenue for the day
      const clubRevenue = await this.revenueAggregator.aggregateDailyRevenue(clubId, dateStr);

      // Step 2: Calculate agent contributions and weights
      const contributionData = await this.contributionCalculator.calculateDailyContributions(clubId, dateStr);

      // Step 3: Compute individual agent earnings
      const earningsResults = [];

      for (const contribution of contributionData.contributions) {
        const earnings = await this.computeAgentEarnings(
          clubId,
          contribution.agentId,
          dateStr,
          clubRevenue,
          contribution,
          contributionData.config
        );
        earningsResults.push(earnings);
      }

      // Step 4: Log audit trail
      await this.logEarningsComputation(clubId, dateStr, userId, {
        clubRevenue,
        contributions: contributionData.contributions,
        earnings: earningsResults
      });

      logger.info({
        clubId,
        date: dateStr,
        agentCount: earningsResults.length,
        totalEarnings: earningsResults.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0)
      }, '[EarningsService] Daily earnings computation completed');

      return {
        clubId,
        date: dateStr,
        clubRevenue,
        agentEarnings: earningsResults,
        summary: {
          totalAgents: earningsResults.length,
          totalBasePay: earningsResults.reduce((sum, e) => sum + parseFloat(e.basePayAmount), 0),
          totalRevenueShare: earningsResults.reduce((sum, e) => sum + parseFloat(e.revenueShareAmount), 0),
          totalBonuses: earningsResults.reduce((sum, e) => sum + parseFloat(e.bonusAmount), 0),
          totalEarnings: earningsResults.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0)
        }
      };

    } catch (error) {
      logger.error({
        err: error,
        clubId,
        date: dateStr
      }, '[EarningsService] Failed to compute daily earnings');
      throw error;
    }
  }

  /**
   * Compute earnings for a specific agent
   */
  async computeAgentEarnings(clubId, agentId, date, clubRevenue, contribution, config) {
    try {
      // Get or create agent shift record
      const shift = await this.ensureAgentShift(clubId, agentId, date, config);

      // Calculate base pay (SLA gate: 90% uptime + COMPLETED status)
      const uptimeThreshold = 90.0; // Fixed 90% as per requirement
      const basePayEligible =
        Number(contribution.uptimePercentage || 0) >= uptimeThreshold &&
        shift.status === 'COMPLETED';
      const basePayAmount = basePayEligible ? parseFloat(shift.basePayAmount) : 0;

      // Calculate revenue share (10% of platform fees distributed by match count)
      const agentPoolAmount = parseFloat(clubRevenue.agentPoolAmount);
      const revenueShareAmount = agentPoolAmount * contribution.weightPercentage;

      // Prepare computation metadata
      const computedFrom = {
        clubRevenueId: clubRevenue.revenueId,
        platformFeeTotal: parseFloat(clubRevenue.totalPlatformFees),
        agentSharePercent: parseFloat(clubRevenue.agentSharePercent),
        agentPoolAmount: agentPoolAmount,
        weightPercentage: contribution.weightPercentage,
        matchesCompleted: contribution.matchesCompleted,
        uptimePercentage: contribution.uptimePercentage
      };

      // Create or update earnings record
      const earningsData = {
        clubId,
        agentId,
        earningsDate: date,
        basePayAmount: basePayAmount,
        revenueShareAmount: revenueShareAmount,
        bonusAmount: 0, // Bonuses removed
        matchesCompleted: contribution.matchesCompleted,
        uptimeMinutes: contribution.uptimeMinutes,
        uptimePercentage: contribution.uptimePercentage,
        matchWeight: contribution.matchWeight,
        uptimeWeight: contribution.uptimeWeight,
        totalWeight: contribution.totalWeight,
        weightPercentage: contribution.weightPercentage,
        computedFrom: computedFrom,
        status: 'DRAFT'
      };

      const earnings = await prisma.agentEarningsDaily.upsert({
        where: {
          clubId_agentId_earningsDate: {
            clubId,
            agentId,
            earningsDate: date
          }
        },
        update: earningsData,
        create: earningsData
      });

      logger.debug({
        agentId,
        date,
        basePayAmount,
        revenueShareAmount,
        totalAmount: earnings.totalAmount
      }, '[EarningsService] Agent earnings computed');

      return earnings;

    } catch (error) {
      logger.error({
        err: error,
        clubId,
        agentId,
        date
      }, '[EarningsService] Failed to compute agent earnings');
      throw error;
    }
  }

  /**
   * Ensure agent shift record exists
   */
  async ensureAgentShift(clubId, agentId, date, config) {
    let shift = await prisma.agentShift.findUnique({
      where: {
        clubId_agentId_shiftDate: {
          clubId,
          agentId,
          shiftDate: date
        }
      }
    });

    if (!shift) {
      // Create default shift record
      shift = await prisma.agentShift.create({
        data: {
          clubId,
          agentId,
          shiftDate: date,
          startTime: '11:00:00',
          endTime: '23:00:00',
          status: 'SCHEDULED',
          basePayAmount: parseFloat(config.basePayAmount)
        }
      });
    }

    return shift;
  }

  /**
   * Finalize earnings for a date (prevents further changes)
   */
  async finalizeEarnings(clubId, date, userId) {
    const dateStr = date instanceof Date ? date.toISOString().split('T')[0] : date;

    logger.info({
      clubId,
      date: dateStr,
      userId
    }, '[EarningsService] Finalizing earnings');

    try {
      // Update all earnings for this club/date to FINALIZED
      const updatedEarnings = await prisma.agentEarningsDaily.updateMany({
        where: {
          clubId,
          earningsDate: dateStr,
          status: 'DRAFT'
        },
        data: {
          status: 'FINALIZED',
          finalizedAt: new Date(),
          finalizedBy: userId
        }
      });

      // Finalize club revenue as well
      await this.revenueAggregator.finalizeRevenue(clubId, dateStr, userId);

      // Log audit trail
      await this.logEarningsAudit(clubId, null, dateStr, 'FINALIZED', userId, {
        finalizedCount: updatedEarnings.count
      });

      logger.info({
        clubId,
        date: dateStr,
        finalizedCount: updatedEarnings.count
      }, '[EarningsService] Earnings finalized');

      return updatedEarnings;

    } catch (error) {
      logger.error({
        err: error,
        clubId,
        date: dateStr
      }, '[EarningsService] Failed to finalize earnings');
      throw error;
    }
  }

  /**
   * Get earnings summary for a club and date range
   */
  async getEarningsSummary(clubId, startDate, endDate) {
    const earnings = await prisma.agentEarningsDaily.findMany({
      where: {
        clubId,
        earningsDate: {
          gte: startDate,
          lte: endDate
        }
      },
      include: {
        // Include related shift data if needed
      },
      orderBy: [
        { earningsDate: 'asc' },
        { agentId: 'asc' }
      ]
    });

    // Group by date
    const byDate = {};
    earnings.forEach(earning => {
      const date = earning.earningsDate.toISOString().split('T')[0];
      if (!byDate[date]) {
        byDate[date] = [];
      }
      byDate[date].push(earning);
    });

    // Calculate totals
    const summary = {
      clubId,
      periodStart: startDate,
      periodEnd: endDate,
      totalDays: Object.keys(byDate).length,
      totalAgentDays: earnings.length,
      totalBasePay: 0,
      totalRevenueShare: 0,
      totalBonuses: 0,
      totalEarnings: 0,
      averageDailyEarnings: 0,
      earningsByDate: byDate
    };

    earnings.forEach(earning => {
      summary.totalBasePay += parseFloat(earning.basePayAmount);
      summary.totalRevenueShare += parseFloat(earning.revenueShareAmount);
      summary.totalBonuses += parseFloat(earning.bonusAmount);
      summary.totalEarnings += parseFloat(earning.totalAmount);
    });

    if (earnings.length > 0) {
      summary.averageDailyEarnings = summary.totalEarnings / earnings.length;
    }

    return summary;
  }

  /**
   * Recompute earnings for a date (only if not finalized)
   */
  async recomputeEarnings(clubId, date, userId) {
    const dateStr = date instanceof Date ? date.toISOString().split('T')[0] : date;

    // Check if already finalized
    const existingEarnings = await prisma.agentEarningsDaily.findFirst({
      where: {
        clubId,
        earningsDate: dateStr,
        status: 'FINALIZED'
      }
    });

    if (existingEarnings) {
      throw new Error('Cannot recompute finalized earnings. Admin override required.');
    }

    logger.info({
      clubId,
      date: dateStr,
      userId
    }, '[EarningsService] Recomputing earnings');

    // Delete existing draft earnings
    await prisma.agentEarningsDaily.deleteMany({
      where: {
        clubId,
        earningsDate: dateStr,
        status: 'DRAFT'
      }
    });

    // Recompute from scratch
    return await this.computeDailyEarnings(clubId, dateStr, userId);
  }

  /**
   * Log earnings computation audit trail
   */
  async logEarningsComputation(clubId, date, userId, computationData) {
    try {
      await this.logEarningsAudit(clubId, null, date, 'COMPUTED', userId, {
        agentCount: computationData.earnings.length,
        totalRevenue: parseFloat(computationData.clubRevenue.totalPlatformFees),
        totalEarnings: computationData.earnings.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0)
      });
    } catch (error) {
      logger.error({ err: error, clubId, date }, '[EarningsService] Failed to log computation audit');
    }
  }

  /**
   * Log earnings audit entry
   */
  async logEarningsAudit(clubId, agentId, date, action, userId, data) {
    try {
      await prisma.earningsAuditLog.create({
        data: {
          clubId,
          agentId,
          earningsDate: date,
          action,
          triggeredBy: userId,
          afterData: data,
          reason: `${action} by ${userId || 'system'}`
        }
      });
    } catch (error) {
      logger.error({ err: error }, '[EarningsService] Failed to create audit log');
    }
  }

  /**
   * Get agent earnings for a specific period
   */
  async getAgentEarnings(agentId, startDate, endDate) {
    const earnings = await prisma.agentEarningsDaily.findMany({
      where: {
        agentId,
        earningsDate: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: {
        earningsDate: 'asc'
      }
    });

    const summary = {
      agentId,
      periodStart: startDate,
      periodEnd: endDate,
      earnings,
      totals: {
        basePay: earnings.reduce((sum, e) => sum + parseFloat(e.basePayAmount), 0),
        revenueShare: earnings.reduce((sum, e) => sum + parseFloat(e.revenueShareAmount), 0),
        bonuses: earnings.reduce((sum, e) => sum + parseFloat(e.bonusAmount), 0),
        total: earnings.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0)
      },
      statistics: {
        totalMatches: earnings.reduce((sum, e) => sum + e.matchesCompleted, 0),
        averageUptime: earnings.length > 0 ?
          earnings.reduce((sum, e) => sum + parseFloat(e.uptimePercentage), 0) / earnings.length : 0,
        daysWorked: earnings.filter(e => e.status === 'FINALIZED').length,
        pendingPayouts: earnings.filter(e => e.status === 'FINALIZED' && !e.paidAt).length
      }
    };

    return summary;
  }
}

module.exports = { EarningsService };
