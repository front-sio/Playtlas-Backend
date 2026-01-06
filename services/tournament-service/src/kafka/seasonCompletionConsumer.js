const axios = require('axios');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, Topics } = require('../../../../shared/events');
const { ensureTournamentSchedule } = require('../jobs/schedulerQueue');

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002';

const PLATFORM_FEE_PERCENTAGE = Number(process.env.PLATFORM_FEE_PERCENTAGE || 30) / 100;
const FIRST_PLACE_PERCENTAGE = Number(process.env.SEASON_FIRST_PLACE_PERCENT || 60) / 100;
const SECOND_PLACE_PERCENTAGE = Number(process.env.SEASON_SECOND_PLACE_PERCENT || 25) / 100;
const THIRD_PLACE_PERCENTAGE = Number(process.env.SEASON_THIRD_PLACE_PERCENT || 15) / 100;

function normalizeMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(2));
}

async function fetchWalletByOwner(ownerId) {
  const response = await axios.get(
    `${WALLET_SERVICE_URL}/owner/${encodeURIComponent(ownerId)}?type=player`,
    { timeout: 10000 }
  );
  return response.data?.data;
}

async function fetchSystemWallet() {
  const response = await axios.get(`${WALLET_SERVICE_URL}/system/wallet`, { timeout: 10000 });
  return response.data?.data;
}

async function fetchPlatformWallet() {
  const response = await axios.get(`${WALLET_SERVICE_URL}/platform/wallet`, { timeout: 10000 });
  return response.data?.data;
}

async function transferFunds({ fromWalletId, toWalletId, amount, description, metadata }) {
  await axios.post(
    `${WALLET_SERVICE_URL}/transfer`,
    {
      fromWalletId,
      toWalletId,
      amount,
      description,
      metadata
    },
    { timeout: 10000 }
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

  const playerCount = season.tournamentPlayers.length;
  const entryFee = Number(season.tournament.entryFee || 0);
  const potAmount = normalizeMoney(entryFee * playerCount);
  if (potAmount <= 0) {
    logger.warn({ seasonId, entryFee, playerCount }, '[seasonCompletion] Pot amount is zero; skipping payout');
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

  let firstAmount = normalizeMoney(remaining * firstPct);
  let secondAmount = normalizeMoney(remaining * secondPct);
  let thirdAmount = normalizeMoney(remaining * thirdPct);

  const distributed = normalizeMoney(firstAmount + secondAmount + thirdAmount);
  const remainder = normalizeMoney(remaining - distributed);
  if (remainder !== 0) {
    firstAmount = normalizeMoney(firstAmount + remainder);
  }

  const payoutMetadata = { tournamentId, seasonId };

  if (platformFee > 0) {
    await transferFunds({
      fromWalletId: systemWallet.walletId,
      toWalletId: platformWallet.walletId,
      amount: platformFee,
      description: `Platform fee for season ${seasonId}`,
      metadata: { ...payoutMetadata, type: 'platform_fee' }
    });
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
    metadata: { ...payoutMetadata, place: 'first' }
  });

  if (placements.second && secondAmount > 0) {
    const runnerUpWallet = await fetchWalletByOwner(placements.second);
    if (runnerUpWallet?.walletId) {
      await transferFunds({
        fromWalletId: systemWallet.walletId,
        toWalletId: runnerUpWallet.walletId,
        amount: secondAmount,
        description: `Season prize (2nd place) for season ${seasonId}`,
        metadata: { ...payoutMetadata, place: 'second' }
      });
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
        metadata: { ...payoutMetadata, place: 'third' }
      });
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
    { seasonId, tournamentId, platformFee, firstAmount, secondAmount, thirdAmount },
    '[seasonCompletion] Payouts completed'
  );

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
