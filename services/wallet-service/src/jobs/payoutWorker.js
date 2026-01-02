const { prisma } = require('../config/db');
const { createWorkerWithDlq } = require('../../../../shared/config/redis');
const { QueueNames } = require('../../../../shared/constants/queueNames');
const { creditWallet } = require('../../../../shared/utils/walletHelper');
const { publishEvent, Topics } = require('../../../../shared/events');
const logger = require('../utils/logger');

function startPayoutWorker() {
  const concurrency = Number(process.env.WALLET_PAYOUT_CONCURRENCY || 5);
  const deadLetterQueueName = `${QueueNames.WALLET_PAYOUTS}-dlq`;

  const worker = createWorkerWithDlq(
    QueueNames.WALLET_PAYOUTS,
    async (job) => {
      const { tournamentId, seasonId, winnerId, winnerWalletId, amount } = job.data || {};

      if (!tournamentId || !seasonId || !amount) {
        throw new Error('Invalid payout job payload');
      }

      let walletId = winnerWalletId;

      if (!walletId && winnerId) {
        const [wallet] = await db
          .select()
          .from(wallets)
          .where(and(eq(wallets.ownerId, winnerId), eq(wallets.type, 'player')))
          .limit(1);

        if (!wallet) {
          throw new Error('Winner wallet not found');
        }

        walletId = wallet.walletId;
      }

      if (!walletId) {
        throw new Error('winnerWalletId or winnerId is required for payout');
      }

      const idempotencyKey = `prize:${tournamentId}:${seasonId}:${walletId}`;

      const { wallet } = await creditWallet(db, { wallets, transactions }, {
        walletId,
        amount,
        type: 'tournament_prize',
        description: `Tournament prize for ${tournamentId}`,
        metadata: { tournamentId, seasonId, winnerId },
        idempotencyKey
      });

      await publishEvent(Topics.PRIZE_CREDITED, {
        tournamentId,
        seasonId,
        winnerId,
        walletId: wallet.walletId,
        amount: String(amount),
        currency: wallet.currency
      });

      logger.info({ tournamentId, seasonId, winnerId, walletId: wallet.walletId }, '[wallet-payout-worker] Prize credited');
    },
    { concurrency, deadLetterQueueName }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, queue: QueueNames.WALLET_PAYOUTS }, '[wallet-payout-worker] Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job && job.id, err }, '[wallet-payout-worker] Job failed');
  });

  return worker;
}

module.exports = {
  startPayoutWorker
};
