const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * RevenueAggregator - Aggregates daily revenue data for clubs
 * 
 * Calculates platform fees from completed tournaments/matches
 * and prepares data for agent payout distribution
 */
class RevenueAggregator {

  /**
   * Aggregate daily revenue for a specific club and date
   */
  async aggregateDailyRevenue(clubId, date) {
    const dateStr = date instanceof Date ? date.toISOString().split('T')[0] : date;

    logger.info({
      clubId,
      date: dateStr
    }, '[RevenueAggregator] Starting daily revenue aggregation');

    try {
      // Get club payout configuration
      const config = await this.getClubPayoutConfig(clubId);

      // Aggregate match-based revenue  
      const matchRevenue = await this.calculateMatchRevenue(clubId, dateStr);

      // Calculate totals
      const totalEntryFees = matchRevenue.totalEntryFees;
      const totalPlatformFees = matchRevenue.totalPlatformFees;

      // Calculate agent pool
      const agentPoolAmount = totalPlatformFees * config.agentSharePercent;

      // Create or update club revenue record
      const revenueData = {
        clubId,
        revenueDate: dateStr,
        totalEntryFees: totalEntryFees,
        totalPlatformFees: totalPlatformFees,
        totalSeasons: matchRevenue.totalSeasons,
        totalMatches: matchRevenue.totalMatches,
        completedMatches: matchRevenue.completedMatches,
        agentSharePercent: config.agentSharePercent,
        agentPoolAmount: agentPoolAmount,
        status: 'DRAFT'
      };

      const clubRevenue = await prisma.clubRevenueDaily.upsert({
        where: {
          clubId_revenueDate: {
            clubId,
            revenueDate: dateStr
          }
        },
        update: revenueData,
        create: revenueData
      });

      logger.info({
        clubId,
        date: dateStr,
        totalPlatformFees,
        agentPoolAmount,
        revenueId: clubRevenue.revenueId
      }, '[RevenueAggregator] Daily revenue aggregation completed');

      return clubRevenue;

    } catch (error) {
      logger.error({
        err: error,
        clubId,
        date: dateStr
      }, '[RevenueAggregator] Failed to aggregate daily revenue');
      throw error;
    }
  }

  /**
   * Calculate tournament-based revenue for the day
   */
  async calculateTournamentRevenue(clubId, date) {
    return {
      totalEntryFees: 0,
      totalPlatformFees: 0,
      seasonsCount: 0
    };
  }

  /**
   * Calculate match-based revenue for the day
   */
  async calculateMatchRevenue(clubId, date) {
    try {
      const startOfDay = new Date(date);
      startOfDay.setUTCHours(0, 0, 0, 0);

      const endOfDay = new Date(date);
      endOfDay.setUTCHours(23, 59, 59, 999);

      const response = await axios.get(
        `${process.env.MATCHMAKING_SERVICE_URL || 'http://matchmaking-service:3009'}/matchmaking/internal/matches`,
        {
          params: {
            clubId,
            startDate: startOfDay.toISOString(),
            endDate: endOfDay.toISOString()
          },
          timeout: 10000
        }
      );
      const completedMatches = response.data?.data?.matches || [];

      let totalEntryFees = 0;
      let totalPlatformFees = 0;

      for (const match of completedMatches) {
        // Extract revenue data from match
        const matchEntryFee = match.entryFee || 0;
        const gameType = match.gameType || 'multiplayer';
        const platformFeePercent = gameType === 'with_ai' ? 0.10 : 0.30;
        const matchPlatformFee = matchEntryFee * platformFeePercent;

        totalEntryFees += matchEntryFee;
        totalPlatformFees += matchPlatformFee;
      }

      const seasonIds = new Set();
      completedMatches.forEach((match) => {
        if (match.seasonId) seasonIds.add(match.seasonId);
      });

      return {
        totalEntryFees,
        totalPlatformFees,
        totalMatches: completedMatches.length,
        completedMatches: completedMatches.length,
        totalSeasons: seasonIds.size
      };

    } catch (error) {
      logger.error({ err: error, clubId, date }, '[RevenueAggregator] Failed to calculate match revenue');
      return {
        totalEntryFees: 0,
        totalPlatformFees: 0,
        totalMatches: 0,
        completedMatches: 0
      };
    }
  }

  /**
   * Get completed seasons for a specific date
   */
  async getCompletedSeasonsForDate(clubId, date) {
    // This is a placeholder - would integrate with actual tournament service
    // For now, return mock data for testing
    return [
      {
        seasonId: 'season-1',
        entryFee: 5000, // TSH
        playerCount: 32,
        completedAt: new Date(date)
      }
    ];
  }

  /**
   * Get completed matches for a date range
   */
  async getCompletedMatchesForDate() {
    return [];
  }

  /**
   * Get club payout configuration
   */
  async getClubPayoutConfig(clubId) {
    let config = await prisma.clubPayoutConfig.findUnique({
      where: { clubId }
    });

    // Create default config if none exists
    if (!config) {
      config = await prisma.clubPayoutConfig.create({
        data: {
          clubId,
          basePayAmount: 1500.00,
          basePayUptimeThreshold: 0.90,
          agentSharePercent: 0.10, // 10%
          weightByMatches: true,
          weightByUptime: false,
          matchWeightPercent: 1.00,
          uptimeWeightPercent: 0.00,
          uptimeBonusEnabled: false,
          uptimeBonusThreshold: 0.95,
          uptimeBonusAmount: 0.00,
          attendanceBonusEnabled: false,
          attendanceBonusAmount: 0.00,
          registrationBonusEnabled: false,
          registrationBonusThreshold: 0.5,
          registrationBonusPercent: 0.00
        }
      });

      logger.info({ clubId }, '[RevenueAggregator] Created default payout config');
    }

    return config;
  }

  /**
   * Aggregate revenue for multiple clubs and date range
   */
  async aggregateRevenueForPeriod(clubIds, startDate, endDate) {
    const results = [];

    const start = new Date(startDate);
    const end = new Date(endDate);

    // Iterate through each date in the range
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().split('T')[0];

      // Process each club for this date
      for (const clubId of clubIds) {
        try {
          const revenue = await this.aggregateDailyRevenue(clubId, dateStr);
          results.push(revenue);
        } catch (error) {
          logger.error({ err: error, clubId, date: dateStr }, '[RevenueAggregator] Failed to aggregate revenue for club/date');
        }
      }
    }

    return results;
  }

  /**
   * Get revenue summary for a club over a period
   */
  async getRevenueSummary(clubId, startDate, endDate) {
    const revenues = await prisma.clubRevenueDaily.findMany({
      where: {
        clubId,
        revenueDate: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: {
        revenueDate: 'asc'
      }
    });

    const summary = {
      clubId,
      periodStart: startDate,
      periodEnd: endDate,
      totalDays: revenues.length,
      totalEntryFees: 0,
      totalPlatformFees: 0,
      totalAgentPool: 0,
      totalSeasons: 0,
      totalMatches: 0,
      averageDailyRevenue: 0
    };

    revenues.forEach(revenue => {
      summary.totalEntryFees += parseFloat(revenue.totalEntryFees);
      summary.totalPlatformFees += parseFloat(revenue.totalPlatformFees);
      summary.totalAgentPool += parseFloat(revenue.agentPoolAmount);
      summary.totalSeasons += revenue.totalSeasons;
      summary.totalMatches += revenue.totalMatches;
    });

    if (revenues.length > 0) {
      summary.averageDailyRevenue = summary.totalPlatformFees / revenues.length;
    }

    return summary;
  }

  /**
   * Finalize revenue for a date (prevents further changes)
   */
  async finalizeRevenue(clubId, date, userId) {
    const revenue = await prisma.clubRevenueDaily.update({
      where: {
        clubId_revenueDate: {
          clubId,
          revenueDate: date
        }
      },
      data: {
        status: 'FINALIZED',
        finalizedAt: new Date(),
        finalizedBy: userId
      }
    });

    logger.info({
      clubId,
      date,
      userId,
      revenueId: revenue.revenueId
    }, '[RevenueAggregator] Revenue finalized');

    return revenue;
  }
}

module.exports = { RevenueAggregator };
