const { prisma } = require('../config/db.js');
const { logger } = require('../utils/logger.js');
const { subscribeEvents, Topics } = require('../../../../shared/events');

function buildReferenceNumber(prefix, seed) {
  return `${prefix}-${seed}`;
}

async function ensureWalletTransfer(data) {
  if (!prisma.walletTransfer) {
    logger.warn('walletTransfer model not available; skipping wallet transfer record');
    return;
  }

  const existing = await prisma.walletTransfer.findUnique({
    where: { referenceNumber: data.referenceNumber }
  });
  if (existing) return;

  await prisma.walletTransfer.create({ data });
}

async function handlePrizeCredited(_topic, payload) {
  const { tournamentId, seasonId, winnerId, walletId, amount, currency, metadata } = payload || {};
  if (!winnerId || !walletId || !amount) return;

  const referenceNumber = buildReferenceNumber('PRIZE', `${seasonId}-${winnerId}-${metadata?.place || 'first'}`);

  await ensureWalletTransfer({
    fromUserId: null,
    fromWalletId: null,
    toUserId: winnerId,
    toWalletId: walletId,
    amount: Number(amount),
    fee: 0,
    currency: currency || 'TZS',
    description: `Season prize payout (${metadata?.place || 'first'})`,
    referenceNumber,
    status: 'completed',
    processedAt: new Date(),
    metadata: {
      tournamentId,
      seasonId,
      type: 'season_prize',
      place: metadata?.place || null
    }
  });
}

async function handlePlatformFeeCredited(_topic, payload) {
  const { tournamentId, seasonId, walletId, amount, currency, metadata } = payload || {};
  if (!walletId || !amount) return;

  const referenceNumber = buildReferenceNumber('PLATFORM-FEE', `${seasonId}`);

  await ensureWalletTransfer({
    fromUserId: null,
    fromWalletId: null,
    toUserId: null,
    toWalletId: walletId,
    amount: Number(amount),
    fee: 0,
    currency: currency || 'TZS',
    description: 'Platform fee payout',
    referenceNumber,
    status: 'completed',
    processedAt: new Date(),
    metadata: {
      tournamentId,
      seasonId,
      type: 'platform_fee',
      ...(metadata || {})
    }
  });
}

async function startPaymentConsumers() {
  await subscribeEvents('payment-service', [Topics.PRIZE_CREDITED, Topics.PLATFORM_FEE_CREDITED], async (topic, payload) => {
    try {
      if (topic === Topics.PRIZE_CREDITED) {
        await handlePrizeCredited(topic, payload);
        return;
      }

      if (topic === Topics.PLATFORM_FEE_CREDITED) {
        await handlePlatformFeeCredited(topic, payload);
      }
    } catch (err) {
      logger.error({ err, payload, topic }, '[payment-consumers] Failed to process wallet credit event');
    }
  });

  logger.info('[payment-consumers] Kafka consumers started');
}

module.exports = {
  startPaymentConsumers
};
