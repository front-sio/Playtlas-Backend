const logger = require('../utils/logger');
const { prisma } = require('../config/db');

const COMMISSION_RATE_DEPOSIT = Number(
  process.env.AGENT_DEPOSIT_COMMISSION_RATE || 0.05
);
const COMMISSION_LOOKBACK_HOURS = Number(
  process.env.AGENT_COMMISSION_LOOKBACK_HOURS || 24
);

class CommissionService {
  async calculateAndDistributeCommissionsForRecentActivity() {
    const recentSince = new Date(
      Date.now() - COMMISSION_LOOKBACK_HOURS * 60 * 60 * 1000
    );

    const players = await this.getEligiblePlayers(recentSince);
    if (!players.length) {
      logger.info(
        '[commissionService] No eligible players found for commission run'
      );
      return;
    }

    logger.info(
      { count: players.length },
      '[commissionService] Processing commission candidates'
    );

    for (const player of players) {
      const commission = this.calculateDepositCommission(player);
      if (!commission) {
        continue;
      }

      await this.recordCommission(player, commission);
      await this.dispatchCommissionPayout(player, commission);
    }
  }

  async getEligiblePlayers(since) {
    return prisma.playerStat.findMany({
      where: {
        agentUserId: { not: null },
        OR: [
          { lastActivityAt: { gte: since } },
          { updatedAt: { gte: since } }
        ]
      },
      select: {
        playerId: true,
        userId: true,
        agentUserId: true,
        totalDepositValue: true,
        lastActivityAt: true,
        updatedAt: true
      }
    });
  }

  calculateDepositCommission(player) {
    const total = Number(player.totalDepositValue || 0);
    if (!total || !player.agentUserId) {
      return 0;
    }

    return Number((total * COMMISSION_RATE_DEPOSIT).toFixed(2));
  }

  async recordCommission(player, amount) {
    // Placeholder: in a full implementation we would persist commission ledgers
    logger.info(
      {
        playerId: player.playerId,
        agentUserId: player.agentUserId,
        amount
      },
      '[commissionService] Commission calculated'
    );
  }

  async dispatchCommissionPayout(player, amount) {
    // Placeholder for integration with wallet/payment service.
    logger.info(
      {
        agentUserId: player.agentUserId,
        sourcePlayerId: player.playerId,
        amount
      },
      '[commissionService] Commission payout enqueued (mock)'
    );
  }
}

module.exports = new CommissionService();
