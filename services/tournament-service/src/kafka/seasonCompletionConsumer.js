const axios = require('axios');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, Topics } = require('../../../../shared/events');
const { getServiceToken } = require('../utils/serviceAuth');

// Defaults for multiplayer; with_ai will override dynamically
const DEFAULT_PLATFORM_FEE_PERCENTAGE = Number(process.env.PLATFORM_FEE_PERCENTAGE || 0.30);
const FIRST_PLACE_PERCENTAGE = 0.6;
const SECOND_PLACE_PERCENTAGE = 0.25;
const THIRD_PLACE_PERCENTAGE = 0.15;

const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:8081/api/payment';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:3000';

function normalizeMoney(value) {
  const v = Math.round(Number(value || 0));
  return isFinite(v) ? v : 0;
}

async function fetchSystemWallet() {
  try {
    const res = await axios.get(`${WALLET_SERVICE_URL}/system/wallet`, { timeout: 10000 });
    return res.data?.data || res.data;
  } catch (err) {
    logger.error({ err }, '[seasonCompletion] Failed to fetch system wallet');
    return null;
  }
}

async function fetchPlatformWallet() {
  try {
    const res = await axios.get(`${WALLET_SERVICE_URL}/platform/wallet`, { timeout: 10000 });
    return res.data?.data || res.data;
  } catch (err) {
    logger.error({ err }, '[seasonCompletion] Failed to fetch platform wallet');
    return null;
  }
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
      toUserId,
      idempotencyKey: referenceNumber // idempotent payouts
    },
    {
      headers: { Authorization: `Bearer ${serviceToken}` },
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
    include: { tournament: true, tournamentPlayers: true }
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

  const playerCount = season.tournamentPlayers.length;
  const entryFee = Number(season.tournament.entryFee || 0);
  
  // For with_ai: potAmount = entryFee × 2 (human + AI) - assumes exactly 2 participants per season
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

  const platformFee = normalizeMoney(potAmount * PLATFORM_FEE_PERCENTAGE);
  const remaining = normalizeMoney(potAmount - platformFee);

  const hasThirdPlace = Boolean(placements.third);
  const hasSecondPlace = Boolean(placements.second);
  let firstPct = FIRST_PLACE_PERCENTAGE;
  let secondPct = hasThirdPlace ? SECOND_PLACE_PERCENTAGE : (hasSecondPlace ? SECOND_PLACE_PERCENTAGE : 0);
  let thirdPct = hasThirdPlace ? THIRD_PLACE_PERCENTAGE : 0;

  if (!hasThirdPlace && hasSecondPlace) {
    const totalPct = FIRST_PLACE_PERCENTAGE + SECOND_PLACE_PERCENTAGE;
    if (totalPct > 0) {
      firstPct = FIRST_PLACE_PERCENTAGE / totalPct;
      secondPct = SECOND_PLACE_PERCENTAGE / totalPct;
    }
  }

    firstAmount = normalizeMoney(remaining * firstPct);
    secondAmount = normalizeMoney(remaining * secondPct);
    thirdAmount = normalizeMoney(remaining * thirdPct);

    const distributed = normalizeMoney(firstAmount + secondAmount + thirdAmount);
    const remainder = normalizeMoney(remaining - distributed);
    if (remainder !== 0) {
      firstAmount = normalizeMoney(firstAmount + remainder); // assign remainder to first
    }
  }

  const payoutMetadata = { tournamentId, seasonId };

  if (platformFee > 0) {
    await transferFunds({
      fromWalletId: systemWallet.walletId,
      toWalletId: platformWallet.walletId,
      amount: platformFee,
      description: isWithAi ? 'Platform fee (with_ai 10%)' : 'Platform fee (multiplayer)',
      metadata: { tournamentId, seasonId, type: 'platform_fee', gameType, feePercent: platformFeePercent },
      referenceNumber: `PLATFORM_FEE:${seasonId}`,
      fromUserId: 'system',
      toUserId: 'platform'
    });
  } catch (err) {
    logger.error({ err, seasonId }, '[seasonCompletion] Platform fee transfer failed');
  }

  // Winner payouts
  const winnerId = placements.first?.playerId;
  if (winnerId && firstAmount > 0) {
    try {
      const winnerWalletRes = await axios.get(`${WALLET_SERVICE_URL}/owner/${winnerId}`, { timeout: 10000 });
      const winnerWalletId = winnerWalletRes.data?.data?.walletId || winnerWalletRes.data?.walletId;
      if (winnerWalletId) {
        await transferFunds({
          fromWalletId: systemWallet.walletId,
          toWalletId: winnerWalletId,
          amount: firstAmount,
          description: isWithAi ? 'Season winner prize (with_ai)' : 'Season winner prize',
          metadata: { tournamentId, seasonId, type: 'winner_prize', gameType, platformFeePercent },
          referenceNumber: `PRIZE_FIRST:${seasonId}:${winnerId}`,
          fromUserId: 'system',
          toUserId: winnerId
        });
      }
    } catch (err) {
      logger.error({ err, seasonId, winnerId }, '[seasonCompletion] First place payout failed');
    }
  }

  // For with_ai, skip runner-up and third
  if (!isWithAi) {
    const secondId = placements.second?.playerId;
    if (secondId && secondAmount > 0) {
      try {
        const secondWalletRes = await axios.get(`${WALLET_SERVICE_URL}/owner/${secondId}`, { timeout: 10000 });
        const secondWalletId = secondWalletRes.data?.data?.walletId || secondWalletRes.data?.walletId;
        if (secondWalletId) {
          await transferFunds({
            fromWalletId: systemWallet.walletId,
            toWalletId: secondWalletId,
            amount: secondAmount,
            description: 'Season runner-up prize',
            metadata: { tournamentId, seasonId, type: 'runner_up_prize', gameType },
            referenceNumber: `PRIZE_SECOND:${seasonId}:${secondId}`,
            fromUserId: 'system',
            toUserId: secondId
          });
        }
      } catch (err) {
        logger.error({ err, seasonId, secondId }, '[seasonCompletion] Second place payout failed');
      }
    }

    const thirdId = placements.third?.playerId;
    if (thirdId && thirdAmount > 0) {
      try {
        const thirdWalletRes = await axios.get(`${WALLET_SERVICE_URL}/owner/${thirdId}`, { timeout: 10000 });
        const thirdWalletId = thirdWalletRes.data?.data?.walletId || thirdWalletRes.data?.walletId;
        if (thirdWalletId) {
          await transferFunds({
            fromWalletId: systemWallet.walletId,
            toWalletId: thirdWalletId,
            amount: thirdAmount,
            description: 'Season third place prize',
            metadata: { tournamentId, seasonId, type: 'third_place_prize', gameType },
            referenceNumber: `PRIZE_THIRD:${seasonId}:${thirdId}`,
            fromUserId: 'system',
            toUserId: thirdId
          });
        }
      } catch (err) {
        logger.error({ err, seasonId, thirdId }, '[seasonCompletion] Third place payout failed');
      }
    }
  }

  logger.info(
    { seasonId, tournamentId, platformFee, firstAmount, secondAmount, thirdAmount },
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
  await subscribeEvents('tournament-service', [Topics.SEASON_COMPLETED], handleSeasonCompleted);
  logger.info('[seasonCompletion] Consumer started');
}

module.exports = {
  startSeasonCompletionConsumer,
  handleSeasonCompleted
};