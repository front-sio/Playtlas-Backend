const axios = require('axios');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, publishEvent, Topics } = require('../../../../shared/events');
const { ensureTournamentSchedule } = require('../jobs/schedulerQueue');
const { emitSeasonUpdate } = require('../utils/socketEmitter');
const jwt = require('jsonwebtoken');

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002';
const PAYMENT_SERVICE_URL =
  process.env.PAYMENT_SERVICE_URL ||
  (process.env.API_GATEWAY_URL ? `${process.env.API_GATEWAY_URL}/api/payment` : null) ||
  'http://localhost:8081/api/payment';
const SERVICE_JWT_TOKEN = process.env.SERVICE_JWT_TOKEN || process.env.PAYMENT_SERVICE_TOKEN;
let cachedServiceToken = null;
let cachedServiceTokenExpiry = 0;

function getServiceToken() {
  if (SERVICE_JWT_TOKEN) return SERVICE_JWT_TOKEN;
  const now = Date.now();
  if (cachedServiceToken && now < cachedServiceTokenExpiry) {
    return cachedServiceToken;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const token = jwt.sign({ userId: 'system', role: 'service' }, secret, { expiresIn: '5m' });
    cachedServiceToken = token;
    cachedServiceTokenExpiry = now + 4 * 60 * 1000;
    return token;
  } catch (err) {
    logger.error({ err }, '[seasonCompletion] Failed to create service token');
    return null;
  }
}

const PLATFORM_FEE_PERCENTAGE = Number(process.env.PLATFORM_FEE_PERCENTAGE || 30) / 100;
const FIRST_PLACE_PERCENTAGE = Number(process.env.SEASON_FIRST_PLACE_PERCENT || 60) / 100;
const SECOND_PLACE_PERCENTAGE = Number(process.env.SEASON_SECOND_PLACE_PERCENT || 25) / 100;
const THIRD_PLACE_PERCENTAGE = Number(process.env.SEASON_THIRD_PLACE_PERCENT || 15) / 100;

function normalizeMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(2));
}

async function safePublish(topic, payload, key) {
  try {
    await publishEvent(topic, payload, key);
  } catch (err) {
    logger.error({ err, topic, payload }, '[seasonCompletion] Failed to publish wallet credit event');
  }
}

async function fetchWalletByOwner(ownerId) {
  const response = await axios.get(
    `${WALLET_SERVICE_URL}/owner/${encodeURIComponent(ownerId)}?type=player`,
    { timeout: 10000 }
  ).catch(() => null);
  if (response?.data?.data) return response.data.data;

  const aiResponse = await axios.get(
    `${WALLET_SERVICE_URL}/owner/${encodeURIComponent(ownerId)}?type=ai`,
    { timeout: 10000 }
  );
  return aiResponse.data?.data;
}

async function fetchSystemWallet() {
  const response = await axios.get(`${WALLET_SERVICE_URL}/system/wallet`, { timeout: 10000 });
  return response.data?.data;
}

async function fetchPlatformWallet() {
  const response = await axios.get(`${WALLET_SERVICE_URL}/platform/wallet`, { timeout: 10000 });
  return response.data?.data;
}

async function transferFunds({ fromWalletId, toWalletId, amount, description, metadata, referenceNumber, fromUserId, toUserId }) {
  const serviceToken = getServiceToken();
  if (!serviceToken) {
    logger.error('[seasonCompletion] SERVICE_JWT_TOKEN not configured; skipping payout transfer');
    throw new Error('Missing service token');
  }

  await axios.post(
    `${PAYMENT_SERVICE_URL}/internal-transfer`,
    {
      fromWalletId,
      toWalletId,
      amount,
      description,
      metadata,
      referenceNumber,
      fromUserId,
      toUserId
    },
    {
      headers: {
        Authorization: `Bearer ${serviceToken}`
      },
      timeout: 10000
    }
  );
}

async function handleSeasonCompleted(payload) {
  const { tournamentId, seasonId, placements, endedAt } = payload || {};
  if (!tournamentId || !seasonId) return;
  if (!placements || !placements.first) {
    logger.info({ seasonId }, '[seasonCompletion] No placements provided; skipping payout');
    return;
  }

  const season = await prisma.season.findUnique({
    where: { seasonId },
    include: {
      tournament: true,
      tournamentPlayers: true
    }
  });

  if (!season || !season.tournament) {
    logger.warn({ tournamentId, seasonId }, '[seasonCompletion] Season or tournament not found');
    return;
  }

  const existingWinners = await prisma.tournamentPlayer.findFirst({
    where: {
      seasonId,
      status: { in: ['winner', 'runner_up', 'third_place'] }
    }
  });
  if (existingWinners) {
    logger.info({ seasonId }, '[seasonCompletion] Winners already set; skipping payout');
    return;
  }

  const tournamentMetadata = season.tournament.metadata || {};
  const gameType = typeof tournamentMetadata === 'string' 
    ? JSON.parse(tournamentMetadata || '{}').gameType 
    : tournamentMetadata.gameType;
  const isWithAi = gameType === 'with_ai' || gameType === 'ai';

  const playerCount = season.tournamentPlayers.length;
  const entryFee = Number(season.tournament.entryFee || 0);
  
  // For with_ai: potAmount = entryFee × 2 (human + AI)
  // For normal: potAmount = entryFee × playerCount
  const potAmount = normalizeMoney(isWithAi ? entryFee * 2 : entryFee * playerCount);
  
  if (potAmount <= 0) {
    logger.warn({ seasonId, entryFee, playerCount, isWithAi }, '[seasonCompletion] Pot amount is zero; skipping payout');
    return;
  }

  const systemWallet = await fetchSystemWallet();
  const platformWallet = await fetchPlatformWallet();
  if (!systemWallet?.walletId || !platformWallet?.walletId) {
    logger.warn({ seasonId }, '[seasonCompletion] Missing system/platform wallet; skipping payout');
    return;
  }

  // For with_ai: platformFeePercent = 0.10 (10%)
  // For normal: platformFeePercent = 0.30 (30%)
  const platformFeePercent = isWithAi ? 0.10 : PLATFORM_FEE_PERCENTAGE;
  const platformFee = normalizeMoney(potAmount * platformFeePercent);
  const remaining = normalizeMoney(potAmount - platformFee);

  // For with_ai: single winner only (no second/third place)
  const hasThirdPlace = !isWithAi && Boolean(placements.third);
  const hasSecondPlace = !isWithAi && Boolean(placements.second);
  let firstPct = FIRST_PLACE_PERCENTAGE;
  let secondPct = hasThirdPlace ? SECOND_PLACE_PERCENTAGE : (hasSecondPlace ? SECOND_PLACE_PERCENTAGE : 0);
  let thirdPct = hasThirdPlace ? THIRD_PLACE_PERCENTAGE : 0;

  if (isWithAi) {
    // Single winner gets all the remaining prize
    firstPct = 1.0;
    secondPct = 0;
    thirdPct = 0;
  } else if (!hasThirdPlace && hasSecondPlace) {
    const totalPct = FIRST_PLACE_PERCENTAGE + SECOND_PLACE_PERCENTAGE;
    if (totalPct > 0) {
      firstPct = FIRST_PLACE_PERCENTAGE / totalPct;
      secondPct = SECOND_PLACE_PERCENTAGE / totalPct;
    }
  }

  let firstAmount = normalizeMoney(remaining * firstPct);
  let secondAmount = normalizeMoney(remaining * secondPct);
  let thirdAmount = normalizeMoney(remaining * thirdPct);

  const distributed = normalizeMoney(firstAmount + secondAmount + thirdAmount);
  const remainder = normalizeMoney(remaining - distributed);
  if (remainder !== 0) {
    firstAmount = normalizeMoney(firstAmount + remainder);
  }

  const payoutMetadata = { 
    tournamentId, 
    seasonId, 
    gameType: gameType || 'pvp',
    feePercent: platformFeePercent
  };

  if (platformFee > 0) {
    await transferFunds({
      fromWalletId: systemWallet.walletId,
      toWalletId: platformWallet.walletId,
      amount: platformFee,
      description: `Platform fee for season ${seasonId}`,
      metadata: { ...payoutMetadata, type: 'platform_fee' },
      referenceNumber: `PLATFORM-FEE-${seasonId}`
    });

    await safePublish(
      Topics.PLATFORM_FEE_CREDITED,
      {
        tournamentId,
        seasonId,
        walletId: platformWallet.walletId,
        amount: platformFee.toFixed(2),
        currency: 'TZS',
        metadata: { ...payoutMetadata, type: 'platform_fee' }
      },
      seasonId
    );
  }

  const winnerWallet = await fetchWalletByOwner(placements.first);
  if (!winnerWallet?.walletId) {
    logger.warn({ seasonId, winnerId: placements.first }, '[seasonCompletion] Winner wallet not found');
    return;
  }

  await transferFunds({
    fromWalletId: systemWallet.walletId,
    toWalletId: winnerWallet.walletId,
    amount: firstAmount,
    description: `Season prize (1st place) for season ${seasonId}`,
    metadata: { ...payoutMetadata, place: 'first', type: 'season_prize' },
    referenceNumber: `PRIZE-${seasonId}-${placements.first}-first`,
    toUserId: placements.first
  });
  await safePublish(
    Topics.PRIZE_CREDITED,
    {
      tournamentId,
      seasonId,
      winnerId: placements.first,
      walletId: winnerWallet.walletId,
      amount: firstAmount.toFixed(2),
      currency: 'TZS',
      metadata: { ...payoutMetadata, place: 'first' }
    },
    placements.first
  );

  if (placements.second && secondAmount > 0) {
    const runnerUpWallet = await fetchWalletByOwner(placements.second);
    if (runnerUpWallet?.walletId) {
      await transferFunds({
        fromWalletId: systemWallet.walletId,
        toWalletId: runnerUpWallet.walletId,
        amount: secondAmount,
        description: `Season prize (2nd place) for season ${seasonId}`,
        metadata: { ...payoutMetadata, place: 'second', type: 'season_prize' },
        referenceNumber: `PRIZE-${seasonId}-${placements.second}-second`,
        toUserId: placements.second
      });
      await safePublish(
        Topics.PRIZE_CREDITED,
        {
          tournamentId,
          seasonId,
          winnerId: placements.second,
          walletId: runnerUpWallet.walletId,
          amount: secondAmount.toFixed(2),
          currency: 'TZS',
          metadata: { ...payoutMetadata, place: 'second' }
        },
        placements.second
      );
    }
  }

  if (placements.third && thirdAmount > 0) {
    const thirdWallet = await fetchWalletByOwner(placements.third);
    if (thirdWallet?.walletId) {
      await transferFunds({
        fromWalletId: systemWallet.walletId,
        toWalletId: thirdWallet.walletId,
        amount: thirdAmount,
        description: `Season prize (3rd place) for season ${seasonId}`,
        metadata: { ...payoutMetadata, place: 'third', type: 'season_prize' },
        referenceNumber: `PRIZE-${seasonId}-${placements.third}-third`,
        toUserId: placements.third
      });
      await safePublish(
        Topics.PRIZE_CREDITED,
        {
          tournamentId,
          seasonId,
          winnerId: placements.third,
          walletId: thirdWallet.walletId,
          amount: thirdAmount.toFixed(2),
          currency: 'TZS',
          metadata: { ...payoutMetadata, place: 'third' }
        },
        placements.third
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.season.update({
      where: { seasonId },
      data: { status: 'completed', endTime: endedAt ? new Date(endedAt) : new Date() }
    });

    await tx.tournamentPlayer.updateMany({
      where: { seasonId, playerId: placements.first },
      data: { status: 'winner' }
    });

    if (placements.second) {
      await tx.tournamentPlayer.updateMany({
        where: { seasonId, playerId: placements.second },
        data: { status: 'runner_up' }
      });
    }

    if (placements.third) {
      await tx.tournamentPlayer.updateMany({
        where: { seasonId, playerId: placements.third },
        data: { status: 'third_place' }
      });
    }
  });

  logger.info(
    { seasonId, tournamentId, gameType, isWithAi, platformFee, firstAmount, secondAmount, thirdAmount },
    '[seasonCompletion] Payouts completed'
  );

  await emitSeasonUpdate({
    tournamentId,
    seasonId,
    event: 'season_completed'
  });

  await ensureTournamentSchedule(tournamentId);
}

async function startSeasonCompletionConsumer() {
  await subscribeEvents('tournament-service', [Topics.SEASON_COMPLETED], async (_topic, payload) => {
    try {
      await handleSeasonCompleted(payload);
    } catch (err) {
      logger.error({ err, payload }, '[seasonCompletion] Failed to process season completion');
    }
  });
  logger.info('[seasonCompletion] Consumer started');
}

module.exports = {
  startSeasonCompletionConsumer
};
