const express = require('express');
const { EarningsService } = require('../services/EarningsService');
const { PayoutService } = require('../services/PayoutService');
const { AgentContributionCalculator } = require('../services/AgentContributionCalculator');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

// Initialize services
const earningsService = new EarningsService();
const payoutService = new PayoutService();
const contributionCalculator = new AgentContributionCalculator();

/**
 * Agent Earnings Controller - Agent interface for viewing earnings
 * 
 * Provides read-only access for agents to:
 * - View daily earnings breakdown
 * - See contribution metrics
 * - Check payout status
 * - View earnings history
 */

// Middleware to verify agent access
const requireAgentAccess = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    const userRole = req.user?.role;
    const agentId = req.params.agentId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // Check if user is the agent or has admin access
    if (userId !== agentId && !['ADMIN', 'CLUB_MANAGER'].includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    next();
  } catch (error) {
    logger.error({ err: error }, '[AgentEarningsController] Access check failed');
    res.status(500).json({
      success: false,
      error: 'Access verification failed'
    });
  }
};

/**
 * GET /api/agent/earnings/:agentId/summary
 * Get earnings summary for agent
 */
router.get('/:agentId/summary', requireAgentAccess, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { startDate, endDate } = req.query;

    // Default to last 30 days if no dates provided
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const earningsSummary = await earningsService.getAgentEarnings(agentId, start, end);
    const payoutsSummary = await payoutService.getAgentPayouts(agentId, start, end);
    const contributionSummary = await contributionCalculator.getAgentContributionSummary(agentId, start, end);

    // Calculate pending earnings (finalized but not paid)
    const pendingEarnings = earningsSummary.earnings.filter(e =>
      e.status === 'FINALIZED' && !e.paidAt
    );
    const pendingAmount = pendingEarnings.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0);

    res.json({
      success: true,
      data: {
        agentId,
        period: { startDate: start, endDate: end },
        earnings: earningsSummary,
        payouts: payoutsSummary,
        contributions: contributionSummary,
        pendingAmount,
        pendingPayouts: pendingEarnings.length
      }
    });

  } catch (error) {
    logger.error({ err: error, agentId: req.params.agentId }, '[AgentEarningsController] Failed to get earnings summary');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve earnings summary'
    });
  }
});

/**
 * GET /api/agent/earnings/:agentId/daily
 * Get daily earnings breakdown
 */
router.get('/:agentId/daily', requireAgentAccess, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Start date and end date required'
      });
    }

    const earnings = await prisma.agentEarningsDaily.findMany({
      where: {
        agentId,
        earningsDate: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: {
        earningsDate: 'desc'
      }
    });

    // Get shift information for context
    const shifts = await prisma.agentShift.findMany({
      where: {
        agentId,
        shiftDate: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: {
        shiftDate: 'desc'
      }
    });

    // Combine earnings with shift data
    const dailyBreakdown = earnings.map(earning => {
      const shift = shifts.find(s =>
        s.shiftDate.toISOString().split('T')[0] === earning.earningsDate.toISOString().split('T')[0]
      );

      return {
        date: earning.earningsDate,
        earnings: {
          basePay: parseFloat(earning.basePayAmount),
          revenueShare: parseFloat(earning.revenueShareAmount),
          bonuses: 0, // Bonuses removed
          total: parseFloat(earning.totalAmount)
        },
        performance: {
          matchesCompleted: earning.matchesCompleted,
          uptimeMinutes: earning.uptimeMinutes,
          uptimePercentage: parseFloat(earning.uptimePercentage),
          weightPercentage: parseFloat(earning.weightPercentage)
        },
        shift: shift ? {
          status: shift.status,
          scheduledStart: shift.startTime,
          scheduledEnd: shift.endTime,
          actualStart: shift.actualStartTime,
          actualEnd: shift.actualEndTime
        } : null,
        status: earning.status,
        paidAt: earning.paidAt,
        computedFrom: earning.computedFrom
      };
    });

    res.json({
      success: true,
      data: {
        agentId,
        period: { startDate, endDate },
        dailyBreakdown,
        totals: {
          totalEarnings: earnings.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0),
          totalBasePay: earnings.reduce((sum, e) => sum + parseFloat(e.basePayAmount), 0),
          totalRevenueShare: earnings.reduce((sum, e) => sum + parseFloat(e.revenueShareAmount), 0),
          totalBonuses: 0, // Bonuses removed
          totalMatches: earnings.reduce((sum, e) => sum + e.matchesCompleted, 0),
          averageUptime: earnings.length > 0 ?
            earnings.reduce((sum, e) => sum + parseFloat(e.uptimePercentage), 0) / earnings.length : 0
        }
      }
    });

  } catch (error) {
    logger.error({ err: error, agentId: req.params.agentId }, '[AgentEarningsController] Failed to get daily earnings');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve daily earnings'
    });
  }
});

/**
 * GET /api/agent/earnings/:agentId/contributions/:date
 * Get detailed contribution breakdown for a specific date
 */
router.get('/:agentId/contributions/:date', requireAgentAccess, async (req, res) => {
  try {
    const { agentId, date } = req.params;

    // Get contribution logs for this date
    const contributions = await prisma.agentContributionLog.findMany({
      where: {
        agentId,
        contributionDate: date
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    // Separate by contribution type
    const matchContributions = contributions.filter(c => c.contributionType === 'MATCH');
    const uptimeContributions = contributions.filter(c => c.contributionType === 'UPTIME');

    // Get earnings for this date
    const earnings = await prisma.agentEarningsDaily.findUnique({
      where: {
        clubId_agentId_earningsDate: {
          // We need to get clubId - this is a simplified version
          clubId: contributions[0]?.clubId || '',
          agentId,
          earningsDate: date
        }
      }
    });

    const breakdown = {
      agentId,
      date,
      matchContributions: matchContributions.map(c => ({
        matchId: c.matchId,
        deviceId: c.deviceId,
        startedAt: c.matchStartedAt,
        completedAt: c.matchCompletedAt,
        duration: c.matchDurationSeconds,
        entryFee: parseFloat(c.matchEntryFee),
        platformFee: parseFloat(c.matchPlatformFee),
        weight: parseFloat(c.contributionWeight)
      })),
      uptimeContribution: uptimeContributions.length > 0 ? {
        uptimeSeconds: uptimeContributions[0]?.matchDurationSeconds || 0,
        uptimeMinutes: Math.floor((uptimeContributions[0]?.matchDurationSeconds || 0) / 60),
        weight: parseFloat(uptimeContributions[0]?.contributionWeight || 0)
      } : null,
      earnings: earnings ? {
        basePay: parseFloat(earnings.basePayAmount),
        revenueShare: parseFloat(earnings.revenueShareAmount),
        bonuses: 0, // Bonuses removed
        total: parseFloat(earnings.totalAmount),
        matchWeight: parseFloat(earnings.matchWeight),
        uptimeWeight: parseFloat(earnings.uptimeWeight),
        totalWeight: parseFloat(earnings.totalWeight),
        weightPercentage: parseFloat(earnings.weightPercentage)
      } : null,
      summary: {
        totalMatches: matchContributions.length,
        totalRevenue: matchContributions.reduce((sum, c) => sum + parseFloat(c.matchPlatformFee), 0),
        totalWeight: contributions.reduce((sum, c) => sum + parseFloat(c.contributionWeight), 0)
      }
    };

    res.json({
      success: true,
      data: breakdown
    });

  } catch (error) {
    logger.error({
      err: error,
      agentId: req.params.agentId,
      date: req.params.date
    }, '[AgentEarningsController] Failed to get contribution details');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve contribution details'
    });
  }
});

/**
 * GET /api/agent/earnings/:agentId/payouts
 * Get payout history for agent
 */
router.get('/:agentId/payouts', requireAgentAccess, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { startDate, endDate, status } = req.query;

    // Default to last 6 months if no dates provided
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000);

    const payoutsSummary = await payoutService.getAgentPayouts(agentId, start, end);

    // Filter by status if provided
    let payouts = payoutsSummary.payouts;
    if (status) {
      payouts = payouts.filter(p => p.status === status);
    }

    // Format payout details for agent view
    const formattedPayouts = payouts.map(payout => ({
      transactionId: payout.transactionId,
      amount: parseFloat(payout.amount),
      method: payout.method,
      status: payout.status,
      period: {
        start: payout.periodStart,
        end: payout.periodEnd
      },
      createdAt: payout.createdAt,
      processedAt: payout.processedAt,
      referenceId: payout.referenceId,
      failureReason: payout.failureReason,
      retryCount: payout.retryCount
    }));

    res.json({
      success: true,
      data: {
        agentId,
        period: { startDate: start, endDate: end },
        payouts: formattedPayouts,
        summary: payoutsSummary.totals
      }
    });

  } catch (error) {
    logger.error({ err: error, agentId: req.params.agentId }, '[AgentEarningsController] Failed to get payouts');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve payout history'
    });
  }
});

/**
 * GET /api/agent/earnings/:agentId/statistics
 * Get performance statistics for agent
 */
router.get('/:agentId/statistics', requireAgentAccess, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { period = '30d' } = req.query;

    // Calculate date range based on period
    let startDate;
    const endDate = new Date();

    switch (period) {
      case '7d':
        startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }

    // Get earnings and contribution data
    const earnings = await prisma.agentEarningsDaily.findMany({
      where: {
        agentId,
        earningsDate: {
          gte: startDate.toISOString().split('T')[0],
          lte: endDate.toISOString().split('T')[0]
        }
      },
      orderBy: {
        earningsDate: 'asc'
      }
    });

    // Calculate statistics
    const statistics = {
      agentId,
      period,
      totalDays: earnings.length,
      performance: {
        totalMatches: earnings.reduce((sum, e) => sum + e.matchesCompleted, 0),
        averageMatchesPerDay: earnings.length > 0 ?
          earnings.reduce((sum, e) => sum + e.matchesCompleted, 0) / earnings.length : 0,
        totalUptimeMinutes: earnings.reduce((sum, e) => sum + e.uptimeMinutes, 0),
        averageUptimePercentage: earnings.length > 0 ?
          earnings.reduce((sum, e) => sum + parseFloat(e.uptimePercentage), 0) / earnings.length : 0,
        bestUptimeDay: earnings.length > 0 ?
          Math.max(...earnings.map(e => parseFloat(e.uptimePercentage))) : 0,
        streakDays: this.calculateStreakDays(earnings)
      },
      earnings: {
        totalEarnings: earnings.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0),
        averageEarningsPerDay: earnings.length > 0 ?
          earnings.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0) / earnings.length : 0,
        totalBasePay: earnings.reduce((sum, e) => sum + parseFloat(e.basePayAmount), 0),
        totalRevenueShare: earnings.reduce((sum, e) => sum + parseFloat(e.revenueShareAmount), 0),
        totalBonuses: 0, // Bonuses removed
        bestEarningsDay: earnings.length > 0 ?
          Math.max(...earnings.map(e => parseFloat(e.totalAmount))) : 0
      },
      trends: this.calculateTrends(earnings)
    };

    res.json({
      success: true,
      data: statistics
    });

  } catch (error) {
    logger.error({ err: error, agentId: req.params.agentId }, '[AgentEarningsController] Failed to get statistics');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve performance statistics'
    });
  }
});

/**
 * Helper function to calculate streak days (consecutive days with earnings)
 */
function calculateStreakDays(earnings) {
  if (earnings.length === 0) return 0;

  let currentStreak = 0;
  let maxStreak = 0;
  let lastDate = null;

  earnings.forEach(earning => {
    const currentDate = new Date(earning.earningsDate);

    if (lastDate) {
      const dayDiff = (currentDate - lastDate) / (1000 * 60 * 60 * 24);

      if (dayDiff === 1) {
        currentStreak++;
      } else {
        maxStreak = Math.max(maxStreak, currentStreak);
        currentStreak = 1;
      }
    } else {
      currentStreak = 1;
    }

    lastDate = currentDate;
  });

  return Math.max(maxStreak, currentStreak);
}

/**
 * Helper function to calculate earnings trends
 */
function calculateTrends(earnings) {
  if (earnings.length < 2) {
    return {
      earningsTrend: 'stable',
      uptimeTrend: 'stable',
      matchesTrend: 'stable'
    };
  }

  const firstHalf = earnings.slice(0, Math.floor(earnings.length / 2));
  const secondHalf = earnings.slice(Math.floor(earnings.length / 2));

  const firstHalfAvgEarnings = firstHalf.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0) / firstHalf.length;
  const secondHalfAvgEarnings = secondHalf.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0) / secondHalf.length;

  const firstHalfAvgUptime = firstHalf.reduce((sum, e) => sum + parseFloat(e.uptimePercentage), 0) / firstHalf.length;
  const secondHalfAvgUptime = secondHalf.reduce((sum, e) => sum + parseFloat(e.uptimePercentage), 0) / secondHalf.length;

  const firstHalfAvgMatches = firstHalf.reduce((sum, e) => sum + e.matchesCompleted, 0) / firstHalf.length;
  const secondHalfAvgMatches = secondHalf.reduce((sum, e) => sum + e.matchesCompleted, 0) / secondHalf.length;

  return {
    earningsTrend: secondHalfAvgEarnings > firstHalfAvgEarnings * 1.1 ? 'increasing' :
      secondHalfAvgEarnings < firstHalfAvgEarnings * 0.9 ? 'decreasing' : 'stable',
    uptimeTrend: secondHalfAvgUptime > firstHalfAvgUptime * 1.05 ? 'increasing' :
      secondHalfAvgUptime < firstHalfAvgUptime * 0.95 ? 'decreasing' : 'stable',
    matchesTrend: secondHalfAvgMatches > firstHalfAvgMatches * 1.1 ? 'increasing' :
      secondHalfAvgMatches < firstHalfAvgMatches * 0.9 ? 'decreasing' : 'stable'
  };
}

module.exports = router;