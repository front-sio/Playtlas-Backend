const axios = require('axios');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');

// Service URLs
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3007';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3003';
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || 'http://localhost:3010';
const TOURNAMENT_SERVICE_URL = process.env.TOURNAMENT_SERVICE_URL || 'http://localhost:3004';

class RevenueAggregationService {
  
  /**
   * Aggregate Platform Revenue for a specific date
   */
  async aggregatePlatformRevenue(date) {
    try {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      // Fetch data from payment service
      const paymentStats = await this.fetchPaymentServiceStats(startDate, endDate);
      
      // Fetch data from wallet service (system wallet)
      const walletStats = await this.fetchWalletServiceStats();
      
      // Calculate platform revenue
      const platformRevenue = {
        date: startDate,
        period: 'daily',
        tournamentFees: 0, // Will be updated by tournament aggregation
        depositFees: paymentStats.depositFees || 0,
        withdrawalFees: paymentStats.withdrawalFees || 0,
        transferFees: 0,
        totalRevenue: (paymentStats.depositFees || 0) + (paymentStats.withdrawalFees || 0),
        currency: 'TZS'
      };

      // Upsert platform revenue
      const result = await prisma.platformRevenue.upsert({
        where: {
          date_period: {
            date: startDate,
            period: 'daily'
          }
        },
        update: platformRevenue,
        create: platformRevenue
      });

      logger.info(`Platform revenue aggregated for ${date}: ${platformRevenue.totalRevenue} TZS`);
      return result;
    } catch (error) {
      logger.error('Error aggregating platform revenue:', error);
      throw error;
    }
  }

  /**
   * Aggregate Revenue by Payment Provider
   */
  async aggregateRevenueByProvider(date) {
    try {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      // Fetch deposit data grouped by provider
      const depositData = await this.fetchDepositsByProvider(startDate, endDate);
      
      // Fetch withdrawal data grouped by provider
      const withdrawalData = await this.fetchWithdrawalsByProvider(startDate, endDate);

      const providers = new Set([
        ...Object.keys(depositData),
        ...Object.keys(withdrawalData)
      ]);

      const results = [];

      for (const provider of providers) {
        const depositRevenue = depositData[provider] || 0;
        const withdrawalRevenue = withdrawalData[provider] || 0;
        const transactionFees = depositRevenue + withdrawalRevenue;

        const result = await prisma.revenueByProvider.upsert({
          where: {
            provider_date: {
              provider,
              date: startDate
            }
          },
          update: {
            depositRevenue,
            withdrawalRevenue,
            transactionFees,
            totalRevenue: transactionFees
          },
          create: {
            provider,
            date: startDate,
            depositRevenue,
            withdrawalRevenue,
            transactionFees,
            totalRevenue: transactionFees
          }
        });

        results.push(result);
      }

      logger.info(`Revenue by provider aggregated for ${date}: ${results.length} providers`);
      return results;
    } catch (error) {
      logger.error('Error aggregating revenue by provider:', error);
      throw error;
    }
  }

  /**
   * Aggregate Agent Revenue
   */
  async aggregateAgentRevenue(date) {
    try {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      // Fetch all agents
      const agents = await this.fetchAllAgents();

      const results = [];

      for (const agent of agents) {
        // Fetch agent's players
        const players = await this.fetchAgentPlayers(agent.agentId || agent.userId);
        
        // Calculate metrics
        const agentMetrics = await this.calculateAgentMetrics(agent, players, startDate, endDate);

        const result = await prisma.agentRevenue.upsert({
          where: {
            agentId_date_period: {
              agentId: agent.agentId || agent.userId,
              date: startDate,
              period: 'daily'
            }
          },
          update: agentMetrics,
          create: {
            agentId: agent.agentId || agent.userId,
            userId: agent.userId,
            agentName: agent.username || agent.name,
            date: startDate,
            period: 'daily',
            ...agentMetrics
          }
        });

        results.push(result);
      }

      logger.info(`Agent revenue aggregated for ${date}: ${results.length} agents`);
      return results;
    } catch (error) {
      logger.error('Error aggregating agent revenue:', error);
      throw error;
    }
  }

  /**
   * Aggregate Player Revenue
   */
  async aggregatePlayerRevenue(date) {
    try {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      // Fetch all players (in batches to avoid memory issues)
      const batchSize = 100;
      let offset = 0;
      let hasMore = true;
      const results = [];

      while (hasMore) {
        const players = await this.fetchPlayersBatch(offset, batchSize);
        
        if (players.length === 0) {
          hasMore = false;
          break;
        }

        for (const player of players) {
          const playerMetrics = await this.calculatePlayerMetrics(player, startDate, endDate);

          const result = await prisma.playerRevenue.upsert({
            where: {
              playerId_date_period: {
                playerId: player.userId,
                date: startDate,
                period: 'daily'
              }
            },
            update: playerMetrics,
            create: {
              playerId: player.userId,
              username: player.username,
              date: startDate,
              period: 'daily',
              ...playerMetrics
            }
          });

          results.push(result);
        }

        offset += batchSize;
        
        if (players.length < batchSize) {
          hasMore = false;
        }
      }

      logger.info(`Player revenue aggregated for ${date}: ${results.length} players`);
      return results;
    } catch (error) {
      logger.error('Error aggregating player revenue:', error);
      throw error;
    }
  }

  /**
   * Calculate comprehensive platform revenue summary
   */
  async getPlatformRevenueSummary(startDate, endDate) {
    try {
      const start = new Date(startDate);
      const end = new Date(endDate);

      const revenues = await prisma.platformRevenue.findMany({
        where: {
          date: {
            gte: start,
            lte: end
          }
        },
        orderBy: { date: 'asc' }
      });

      const summary = {
        totalRevenue: 0,
        totalTournamentFees: 0,
        totalDepositFees: 0,
        totalWithdrawalFees: 0,
        totalTransferFees: 0,
        dailyAverage: 0,
        trend: 0,
        data: revenues
      };

      if (revenues.length > 0) {
        summary.totalRevenue = revenues.reduce((sum, r) => sum + r.totalRevenue, 0);
        summary.totalTournamentFees = revenues.reduce((sum, r) => sum + r.tournamentFees, 0);
        summary.totalDepositFees = revenues.reduce((sum, r) => sum + r.depositFees, 0);
        summary.totalWithdrawalFees = revenues.reduce((sum, r) => sum + r.withdrawalFees, 0);
        summary.totalTransferFees = revenues.reduce((sum, r) => sum + r.transferFees, 0);
        summary.dailyAverage = summary.totalRevenue / revenues.length;

        // Calculate trend (compare first half to second half)
        const midPoint = Math.floor(revenues.length / 2);
        const firstHalf = revenues.slice(0, midPoint).reduce((sum, r) => sum + r.totalRevenue, 0);
        const secondHalf = revenues.slice(midPoint).reduce((sum, r) => sum + r.totalRevenue, 0);
        summary.trend = firstHalf > 0 ? ((secondHalf - firstHalf) / firstHalf) * 100 : 0;
      }

      return summary;
    } catch (error) {
      logger.error('Error getting platform revenue summary:', error);
      throw error;
    }
  }

  /**
   * Get Agent Revenue Summary
   */
  async getAgentRevenueSummary(startDate, endDate, agentId = null) {
    try {
      const start = new Date(startDate);
      const end = new Date(endDate);

      const where = {
        date: { gte: start, lte: end }
      };

      if (agentId) {
        where.agentId = agentId;
      }

      const revenues = await prisma.agentRevenue.findMany({
        where,
        orderBy: [
          { totalRevenue: 'desc' },
          { date: 'desc' }
        ],
        take: agentId ? undefined : 100
      });

      const summary = {
        totalRevenue: 0,
        totalCommission: 0,
        totalPlayersRegistered: 0,
        totalActivePlayers: 0,
        topAgents: [],
        data: revenues
      };

      if (revenues.length > 0) {
        summary.totalRevenue = revenues.reduce((sum, r) => sum + r.playerRevenue, 0);
        summary.totalCommission = revenues.reduce((sum, r) => sum + r.commissionEarned, 0);
        summary.totalPlayersRegistered = revenues.reduce((sum, r) => sum + r.playersRegistered, 0);
        
        // Get unique agents for top performers
        const agentMap = new Map();
        for (const r of revenues) {
          if (!agentMap.has(r.agentId)) {
            agentMap.set(r.agentId, {
              agentId: r.agentId,
              userId: r.userId,
              agentName: r.agentName,
              totalRevenue: 0,
              totalCommission: 0,
              playerCount: 0
            });
          }
          const agent = agentMap.get(r.agentId);
          agent.totalRevenue += r.playerRevenue;
          agent.totalCommission += r.commissionEarned;
          agent.playerCount += r.playersRegistered;
        }

        summary.topAgents = Array.from(agentMap.values())
          .sort((a, b) => b.totalRevenue - a.totalRevenue)
          .slice(0, 10);
      }

      return summary;
    } catch (error) {
      logger.error('Error getting agent revenue summary:', error);
      throw error;
    }
  }

  /**
   * Get Player Revenue Summary
   */
  async getPlayerRevenueSummary(startDate, endDate, playerId = null, limit = 100, offset = 0) {
    try {
      const start = new Date(startDate);
      const end = new Date(endDate);

      const where = {
        date: { gte: start, lte: end }
      };

      if (playerId) {
        where.playerId = playerId;
      }

      const [revenues, total] = await Promise.all([
        prisma.playerRevenue.findMany({
          where,
          orderBy: [
            { lifetimeValue: 'desc' },
            { date: 'desc' }
          ],
          take: limit,
          skip: offset
        }),
        prisma.playerRevenue.count({ where })
      ]);

      const summary = {
        totalPlayers: total,
        totalWinnings: 0,
        totalLosses: 0,
        totalFeesPaid: 0,
        totalDeposits: 0,
        totalWithdrawals: 0,
        totalLifetimeValue: 0,
        averageLifetimeValue: 0,
        topPlayers: [],
        data: revenues,
        pagination: {
          total,
          limit,
          offset,
          pages: Math.ceil(total / limit)
        }
      };

      if (revenues.length > 0) {
        summary.totalWinnings = revenues.reduce((sum, r) => sum + r.totalWinnings, 0);
        summary.totalLosses = revenues.reduce((sum, r) => sum + r.totalLosses, 0);
        summary.totalFeesPaid = revenues.reduce((sum, r) => sum + r.feesPaid, 0);
        summary.totalDeposits = revenues.reduce((sum, r) => sum + r.totalDeposits, 0);
        summary.totalWithdrawals = revenues.reduce((sum, r) => sum + r.totalWithdrawals, 0);
        summary.totalLifetimeValue = revenues.reduce((sum, r) => sum + r.lifetimeValue, 0);
        summary.averageLifetimeValue = summary.totalLifetimeValue / revenues.length;
      }

      return summary;
    } catch (error) {
      logger.error('Error getting player revenue summary:', error);
      throw error;
    }
  }

  // Helper methods

  async fetchPaymentServiceStats(startDate, endDate) {
    try {
      const response = await axios.get(`${PAYMENT_SERVICE_URL}/admin/stats`, {
        params: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString()
        }
      });
      return response.data?.data || {};
    } catch (error) {
      logger.warn('Failed to fetch payment service stats:', error.message);
      return { depositFees: 0, withdrawalFees: 0 };
    }
  }

  async fetchWalletServiceStats() {
    try {
      const response = await axios.get(`${WALLET_SERVICE_URL}/system/wallet`);
      return response.data?.data || {};
    } catch (error) {
      logger.warn('Failed to fetch wallet service stats:', error.message);
      return { balance: 0 };
    }
  }

  async fetchDepositsByProvider(startDate, endDate) {
    try {
      const response = await axios.get(`${PAYMENT_SERVICE_URL}/admin/transactions`, {
        params: {
          type: 'deposit',
          status: 'completed',
          limit: 10000
        }
      });

      const deposits = response.data?.data?.transactions || [];
      const byProvider = {};

      for (const deposit of deposits) {
        const depositDate = new Date(deposit.createdAt);
        if (depositDate >= startDate && depositDate < endDate) {
          const provider = deposit.provider || 'unknown';
          byProvider[provider] = (byProvider[provider] || 0) + (deposit.fee || 0);
        }
      }

      return byProvider;
    } catch (error) {
      logger.warn('Failed to fetch deposits by provider:', error.message);
      return {};
    }
  }

  async fetchWithdrawalsByProvider(startDate, endDate) {
    try {
      const response = await axios.get(`${PAYMENT_SERVICE_URL}/admin/transactions`, {
        params: {
          type: 'withdrawal',
          status: 'completed',
          limit: 10000
        }
      });

      const withdrawals = response.data?.data?.transactions || [];
      const byProvider = {};

      for (const withdrawal of withdrawals) {
        const withdrawalDate = new Date(withdrawal.createdAt);
        if (withdrawalDate >= startDate && withdrawalDate < endDate) {
          const provider = withdrawal.provider || 'unknown';
          byProvider[provider] = (byProvider[provider] || 0) + (withdrawal.fee || 0);
        }
      }

      return byProvider;
    } catch (error) {
      logger.warn('Failed to fetch withdrawals by provider:', error.message);
      return {};
    }
  }

  async fetchAllAgents() {
    try {
      const response = await axios.get(`${AGENT_SERVICE_URL}/agents`, {
        params: { limit: 1000 }
      });
      return response.data?.data || [];
    } catch (error) {
      logger.warn('Failed to fetch agents:', error.message);
      return [];
    }
  }

  async fetchAgentPlayers(agentId) {
    try {
      const response = await axios.get(`${AGENT_SERVICE_URL}/players`);
      return response.data?.data?.filter(p => p.agentId === agentId) || [];
    } catch (error) {
      logger.warn('Failed to fetch agent players:', error.message);
      return [];
    }
  }

  async calculateAgentMetrics(agent, players, startDate, endDate) {
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let activePlayers = 0;
    let playerRevenue = 0;

    for (const player of players) {
      // Fetch player transactions (simplified)
      try {
        const response = await axios.get(`${WALLET_SERVICE_URL}/owner/${player.playerId}`, {
          params: { type: 'player' }
        });
        const wallet = response.data?.data;
        if (wallet) {
          playerRevenue += parseFloat(wallet.balance) || 0;
        }
      } catch (error) {
        // Ignore individual player errors
      }
    }

    // Calculate commission (10% of player revenue for example)
    const commissionEarned = playerRevenue * 0.1;

    return {
      commissionEarned,
      playersRegistered: players.length,
      activePlayers,
      totalDeposits,
      totalWithdrawals,
      playerRevenue
    };
  }

  async fetchPlayersBatch(offset, limit) {
    try {
      const response = await axios.get(`${WALLET_SERVICE_URL}/admin/wallets`, {
        params: { type: 'player', limit, offset }
      });
      return response.data?.data || [];
    } catch (error) {
      logger.warn('Failed to fetch players batch:', error.message);
      return [];
    }
  }

  async calculatePlayerMetrics(player, startDate, endDate) {
    try {
      const response = await axios.get(`${WALLET_SERVICE_URL}/owner/${player.ownerId}`, {
        params: { type: 'player' }
      });
      const wallet = response.data?.data;

      if (!wallet) {
        return {
          totalWinnings: 0,
          totalLosses: 0,
          feesPaid: 0,
          netProfit: 0,
          totalDeposits: 0,
          totalWithdrawals: 0,
          gamesPlayed: 0,
          tournamentsPlayed: 0,
          lifetimeValue: 0,
          profitabilityScore: 0
        };
      }

      const totalWinnings = wallet.totalWins || 0;
      const totalLosses = wallet.totalLosses || 0;
      const netProfit = totalWinnings - totalLosses;
      const lifetimeValue = parseFloat(wallet.balance) || 0;

      // Calculate profitability score (-100 to 100)
      const profitabilityScore = (netProfit / (totalWinnings + totalLosses)) * 100 || 0;

      return {
        totalWinnings,
        totalLosses,
        feesPaid: 0, // Would need to be fetched from payment service
        netProfit,
        totalDeposits: 0, // Would need to be fetched from payment service
        totalWithdrawals: 0, // Would need to be fetched from payment service
        gamesPlayed: 0, // Would need to be fetched from game service
        tournamentsPlayed: 0, // Would need to be fetched from tournament service
        lifetimeValue,
        profitabilityScore
      };
    } catch (error) {
      return {
        totalWinnings: 0,
        totalLosses: 0,
        feesPaid: 0,
        netProfit: 0,
        totalDeposits: 0,
        totalWithdrawals: 0,
        gamesPlayed: 0,
        tournamentsPlayed: 0,
        lifetimeValue: 0,
        profitabilityScore: 0
      };
    }
  }
}

module.exports = new RevenueAggregationService();
