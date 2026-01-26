const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const logger = require('../utils/logger');

const prisma = new PrismaClient();
const MATCHMAKING_SERVICE_URL = process.env.MATCHMAKING_SERVICE_URL || 'http://matchmaking-service:3009';

/**
 * AgentContributionCalculator - Calculates agent contributions and weights
 * 
 * Tracks match completions, uptime, and calculates weighted contributions
 * for revenue share distribution
 */
class AgentContributionCalculator {

  /**
   * Calculate contributions for all agents in a club for a specific date
   */
  async calculateDailyContributions(clubId, date) {
    const dateStr = date instanceof Date ? date.toISOString().split('T')[0] : date;

    logger.info({
      clubId,
      date: dateStr
    }, '[AgentContributionCalculator] Starting daily contribution calculation');

    try {
      // Get club configuration
      const config = await this.getClubPayoutConfig(clubId);

      // Get all active agents for this club on this date
      const activeAgents = await this.getActiveAgentsForDate(clubId, dateStr);

      const contributions = [];

      for (const agent of activeAgents) {
        const contribution = await this.calculateAgentContribution(
          clubId,
          agent.agentId,
          dateStr,
          config
        );
        contributions.push(contribution);
      }

      // Calculate total weights for percentage distribution
      const totalWeight = contributions.reduce((sum, contrib) => sum + contrib.totalWeight, 0);

      // Update weight percentages
      contributions.forEach(contrib => {
        contrib.weightPercentage = totalWeight > 0 ? (contrib.totalWeight / totalWeight) : 0;
      });

      logger.info({
        clubId,
        date: dateStr,
        agentCount: contributions.length,
        totalWeight
      }, '[AgentContributionCalculator] Daily contribution calculation completed');

      return {
        clubId,
        date: dateStr,
        contributions,
        totalWeight,
        config
      };

    } catch (error) {
      logger.error({
        err: error,
        clubId,
        date: dateStr
      }, '[AgentContributionCalculator] Failed to calculate daily contributions');
      throw error;
    }
  }

  /**
   * Calculate individual agent contribution for a specific date
   */
  async calculateAgentContribution(clubId, agentId, date, config) {
    try {
      // Get match contributions
      const matchContributions = await this.getMatchContributions(clubId, agentId, date);

      // Get uptime contributions
      const uptimeContributions = await this.getUptimeContributions(clubId, agentId, date);

      // Calculate weights based on configuration
      let matchWeight = 0;
      let uptimeWeight = 0;

      if (config.weightByMatches) {
        matchWeight = matchContributions.matchCount * parseFloat(config.matchWeightPercent);
      }

      if (config.weightByUptime) {
        uptimeWeight = (uptimeContributions.uptimePercentage / 100) * parseFloat(config.uptimeWeightPercent);
      }

      const totalWeight = matchWeight + uptimeWeight;

      // Log individual contributions for audit trail
      await this.logAgentContributions(clubId, agentId, date, matchContributions, uptimeContributions);

      const contribution = {
        agentId,
        matchesCompleted: matchContributions.matchCount,
        totalRevenue: matchContributions.totalRevenue,
        uptimeMinutes: uptimeContributions.uptimeMinutes,
        uptimePercentage: uptimeContributions.uptimePercentage,
        matchWeight,
        uptimeWeight,
        totalWeight,
        weightPercentage: 0, // Will be calculated after all agents processed
        matchDetails: matchContributions.matches,
        shiftDetails: uptimeContributions.shift
      };

      return contribution;

    } catch (error) {
      logger.error({
        err: error,
        clubId,
        agentId,
        date
      }, '[AgentContributionCalculator] Failed to calculate agent contribution');
      throw error;
    }
  }

  /**
   * Get match contributions for an agent on a specific date
   */
  async getMatchContributions(clubId, agentId, date) {
    try {
      const startOfDay = new Date(date);
      startOfDay.setUTCHours(0, 0, 0, 0);

      const endOfDay = new Date(date);
      endOfDay.setUTCHours(23, 59, 59, 999);

      // Query completed matches handled by this agent
      const matches = await this.getCompletedMatchesByAgent(clubId, agentId, startOfDay, endOfDay);

      let totalRevenue = 0;

      const matchDetails = matches.map(match => {
        const gameType = match.gameType || 'multiplayer';
        const platformFeePercent = gameType === 'with_ai' ? 0.10 : 0.30;
        const matchRevenue = (match.entryFee || 0) * platformFeePercent;
        totalRevenue += matchRevenue;

        return {
          matchId: match.matchId,
          deviceId: match.deviceId,
          startedAt: match.startedAt,
          completedAt: match.completedAt,
          duration: match.durationSeconds,
          entryFee: match.entryFee,
          platformFee: matchRevenue,
          gameType
        };
      });

      return {
        matchCount: matches.length,
        totalRevenue,
        matches: matchDetails
      };

    } catch (error) {
      logger.error({ err: error, clubId, agentId, date }, '[AgentContributionCalculator] Failed to get match contributions');
      return {
        matchCount: 0,
        totalRevenue: 0,
        matches: []
      };
    }
  }

  /**
   * Get uptime contributions for an agent on a specific date
   */
  async getUptimeContributions(clubId, agentId, date) {
    try {
      // Get agent shift for this date
      const shift = await prisma.agentShift.findUnique({
        where: {
          clubId_agentId_shiftDate: {
            clubId,
            agentId,
            shiftDate: date
          }
        }
      });

      if (!shift) {
        return {
          uptimeMinutes: 0,
          uptimePercentage: 0,
          shift: null
        };
      }

      // Calculate uptime based on shift status and times
      let uptimeMinutes = 0;
      let uptimePercentage = 0;

      if (shift.status === 'COMPLETED' && shift.actualStartTime && shift.actualEndTime) {
        // Calculate actual minutes worked
        const startTime = new Date(shift.actualStartTime);
        const endTime = new Date(shift.actualEndTime);
        uptimeMinutes = Math.floor((endTime - startTime) / (1000 * 60));

        // Calculate expected shift duration (11 AM to 11 PM = 12 hours = 720 minutes)
        const expectedMinutes = 12 * 60; // 720 minutes
        uptimePercentage = Math.min(100, (uptimeMinutes / expectedMinutes) * 100);
      }

      return {
        uptimeMinutes,
        uptimePercentage,
        shift: {
          shiftId: shift.shiftId,
          status: shift.status,
          scheduledStart: shift.startTime,
          scheduledEnd: shift.endTime,
          actualStart: shift.actualStartTime,
          actualEnd: shift.actualEndTime
        }
      };

    } catch (error) {
      logger.error({ err: error, clubId, agentId, date }, '[AgentContributionCalculator] Failed to get uptime contributions');
      return {
        uptimeMinutes: 0,
        uptimePercentage: 0,
        shift: null
      };
    }
  }

  /**
   * Get completed matches by agent for date range
   */
  async getCompletedMatchesByAgent(clubId, agentId, startDate, endDate) {
    try {
      const agentPlayers = await prisma.agentPlayer.findMany({
        where: { agentId },
        select: { playerId: true }
      });
      const playerIds = agentPlayers.map((row) => row.playerId);
      if (playerIds.length === 0) {
        return [];
      }

      const response = await axios.get(
        `${MATCHMAKING_SERVICE_URL}/matchmaking/internal/matches`,
        {
          params: {
            clubId,
            playerIds: playerIds.join(','),
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString()
          },
          timeout: 10000
        }
      );
      return response.data?.data?.matches || [];
    } catch (error) {
      logger.error({ err: error, clubId, agentId }, '[AgentContributionCalculator] Failed to fetch matches');
      return [];
    }
  }

  /**
   * Get active agents for a club on a specific date
   */
  async getActiveAgentsForDate(clubId, date) {
    const shifts = await prisma.agentShift.findMany({
      where: {
        clubId,
        shiftDate: date,
        status: {
          in: ['SCHEDULED', 'ACTIVE', 'COMPLETED']
        }
      }
    });

    return shifts.map(shift => ({
      agentId: shift.agentId,
      shiftId: shift.shiftId,
      status: shift.status
    }));
  }

  /**
   * Log agent contributions for audit trail
   */
  async logAgentContributions(clubId, agentId, date, matchContributions, uptimeContributions) {
    try {
      const logs = [];

      // Log each match contribution
      for (const match of matchContributions.matches) {
        logs.push({
          clubId,
          agentId,
          contributionDate: date,
          matchId: match.matchId,
          deviceId: match.deviceId,
          matchStartedAt: match.startedAt,
          matchCompletedAt: match.completedAt,
          matchDurationSeconds: match.duration,
          matchEntryFee: match.entryFee,
          matchPlatformFee: match.platformFee,
          contributionWeight: 1.0,
          contributionType: 'MATCH'
        });
      }

      // Log uptime contribution if applicable
      if (uptimeContributions.uptimeMinutes > 0) {
        logs.push({
          clubId,
          agentId,
          contributionDate: date,
          matchId: null,
          deviceId: null,
          matchStartedAt: null,
          matchCompletedAt: null,
          matchDurationSeconds: uptimeContributions.uptimeMinutes * 60,
          matchEntryFee: 0,
          matchPlatformFee: 0,
          contributionWeight: uptimeContributions.uptimePercentage / 100,
          contributionType: 'UPTIME'
        });
      }

      // Bulk insert contribution logs
      if (logs.length > 0) {
        await prisma.agentContributionLog.createMany({
          data: logs,
          skipDuplicates: true
        });
      }

    } catch (error) {
      logger.error({
        err: error,
        clubId,
        agentId,
        date
      }, '[AgentContributionCalculator] Failed to log agent contributions');
    }
  }

  /**
   * Get club payout configuration
   */
  async getClubPayoutConfig(clubId) {
    let config = await prisma.clubPayoutConfig.findUnique({
      where: { clubId }
    });

    if (!config) {
      // Create default config
      config = await prisma.clubPayoutConfig.create({
        data: {
          clubId,
          basePayAmount: 1500.00,
          basePayUptimeThreshold: 0.90,
          agentSharePercent: 0.10,
          weightByMatches: true,
          weightByUptime: false,
          matchWeightPercent: 1.00,
          uptimeWeightPercent: 0.00,
          registrationBonusEnabled: false,
          registrationBonusThreshold: 0.5,
          registrationBonusPercent: 0.00
        }
      });
    }

    return config;
  }

  /**
   * Get contribution summary for an agent over a period
   */
  async getAgentContributionSummary(agentId, startDate, endDate) {
    const logs = await prisma.agentContributionLog.findMany({
      where: {
        agentId,
        contributionDate: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: {
        contributionDate: 'asc'
      }
    });

    const summary = {
      agentId,
      periodStart: startDate,
      periodEnd: endDate,
      totalMatches: 0,
      totalRevenue: 0,
      totalUptimeMinutes: 0,
      averageUptimePercentage: 0,
      contributionsByDate: {}
    };

    logs.forEach(log => {
      const date = log.contributionDate.toISOString().split('T')[0];

      if (!summary.contributionsByDate[date]) {
        summary.contributionsByDate[date] = {
          matches: 0,
          revenue: 0,
          uptimeMinutes: 0
        };
      }

      if (log.contributionType === 'MATCH') {
        summary.totalMatches++;
        summary.totalRevenue += parseFloat(log.matchPlatformFee);
        summary.contributionsByDate[date].matches++;
        summary.contributionsByDate[date].revenue += parseFloat(log.matchPlatformFee);
      } else if (log.contributionType === 'UPTIME') {
        const uptimeMinutes = Math.floor(log.matchDurationSeconds / 60);
        summary.totalUptimeMinutes += uptimeMinutes;
        summary.contributionsByDate[date].uptimeMinutes += uptimeMinutes;
      }
    });

    // Calculate average uptime percentage
    const uptimeDays = Object.keys(summary.contributionsByDate).length;
    if (uptimeDays > 0) {
      summary.averageUptimePercentage = (summary.totalUptimeMinutes / (uptimeDays * 720)) * 100; // 720 minutes per day
    }

    return summary;
  }
}

module.exports = { AgentContributionCalculator };
