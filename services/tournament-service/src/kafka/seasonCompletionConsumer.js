const axios = require('axios');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, Topics } = require('../../../../shared/events');
const { getServiceToken } = require('../utils/serviceAuth');
const { emitSeasonUpdate } = require('../utils/socketEmitter');
const { ensureTournamentSchedule } = require('../jobs/schedulerQueue');

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

function normalizePlacementId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value.playerId || value.id || null;
  }
  return null;
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
  const isDraw = Boolean(payload?.draw || placements?.draw);
  if (!placements || (!placements.first && !isDraw)) {
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
  const skipPayout = Boolean(existingWinners && !isDraw);
  if (skipPayout) {
    logger.info({ seasonId }, '[seasonCompletion] Winners already set; skipping payout');
  }

  const playerCount = season.tournamentPlayers.length;
  const entryFee = Number(season.tournament.entryFee || 0);

  // Determine game type
  const gameType = season.tournament.gameType || 'normal';
  const isWithAi = false;

  // Platform fee percentage: 10% for with_ai, 30% for normal
  const platformFeePercent = isWithAi ? 0.10 : DEFAULT_PLATFORM_FEE_PERCENTAGE;
  const effectiveFeePercent = Math.min(Math.max(platformFeePercent, 0), 1);

  // For with_ai: potAmount = entryFee × 2 (human + AI) - assumes exactly 2 participants per season
  // For normal: potAmount = entryFee × playerCount
  const grossPotAmount = normalizeMoney(isWithAi ? entryFee * 2 : entryFee * playerCount);
  const potAmount = normalizeMoney(grossPotAmount * (1 - effectiveFeePercent));

  if (potAmount <= 0) {
    logger.warn({ seasonId, entryFee, playerCount, isWithAi, grossPotAmount }, '[seasonCompletion] Pot amount is zero; skipping payout');
    if (!skipPayout) {
      await prisma.season.updateMany({
        where: { seasonId, tournamentId, status: { not: 'completed' } },
        data: {
          status: 'completed',
          completedAt: endedAt ? new Date(endedAt) : new Date(),
          finalMatchId: payload?.finalMatchId || null,
          finalizedByJobId: payload?.finalizedByJobId || null,
          errorReason: null
        }
      });
    }
    return;
  }

  const systemWallet = await fetchSystemWallet();
  if (!systemWallet?.walletId) {
    logger.warn({ seasonId }, '[seasonCompletion] Missing system wallet; skipping payout');
    if (!skipPayout) {
      await prisma.season.updateMany({
        where: { seasonId, tournamentId, status: { not: 'completed' } },
        data: {
          status: 'completed',
          completedAt: endedAt ? new Date(endedAt) : new Date(),
          finalMatchId: payload?.finalMatchId || null,
          finalizedByJobId: payload?.finalizedByJobId || null,
          errorReason: null
        }
      });
    }
    return;
  }

  const platformFee = 0;
  const remaining = normalizeMoney(potAmount);

  const playerCount = Number(placements.playerCount || season.tournamentPlayers.length);
  
  // Winner gets 100% of the pot in all cases
  let firstPct = 1.0;
  let secondPct = 0;
  let thirdPct = 0;

  // compute amounts and distribute remainder to first place
  let firstAmount = normalizeMoney(remaining * firstPct);
  let secondAmount = normalizeMoney(remaining * secondPct);
  let thirdAmount = normalizeMoney(remaining * thirdPct);

  const distributed = normalizeMoney(firstAmount + secondAmount + thirdAmount);
  const remainder = normalizeMoney(remaining - distributed);
  if (remainder !== 0) {
    firstAmount = normalizeMoney(firstAmount + remainder); // assign remainder to first
  }

  const payoutMetadata = { tournamentId, seasonId };

  // Platform fee is collected at join; no season completion transfer needed.

  if (!skipPayout && isDraw) {
    const participants = Array.isArray(placements?.participants) && placements.participants.length > 0
      ? placements.participants.filter(Boolean)
      : season.tournamentPlayers.map((player) => player.playerId).filter(Boolean);
    const perPlayerRefund = participants.length > 0
      ? normalizeMoney(remaining / participants.length)
      : 0;
    if (participants.length === 0) {
      logger.warn({ seasonId, tournamentId }, '[seasonCompletion] Draw refund skipped: no participants resolved');
    }
    logger.info(
      { seasonId, tournamentId, participants: participants.length, perPlayerRefund, platformFee },
      '[seasonCompletion] Processing draw refunds'
    );
    for (const participantId of participants) {
      if (!participantId || perPlayerRefund <= 0) continue;
      try {
        const walletRes = await axios.get(`${WALLET_SERVICE_URL}/owner/${participantId}`, { timeout: 10000 });
        const walletId = walletRes.data?.data?.walletId || walletRes.data?.walletId;
        if (!walletId) continue;
        await transferFunds({
          fromWalletId: systemWallet.walletId,
          toWalletId: walletId,
          amount: perPlayerRefund,
          description: isWithAi ? 'Draw refund (with_ai)' : 'Draw refund',
          metadata: { tournamentId, seasonId, type: 'draw_refund', gameType, platformFeePercent },
          referenceNumber: `DRAW_REFUND:${seasonId}:${participantId}`,
          fromUserId: 'system',
          toUserId: participantId
        });
      } catch (err) {
        logger.error({ err, seasonId, participantId }, '[seasonCompletion] Draw refund failed');
      }
    }
  } else if (!skipPayout) {
    // Winner payouts
    const winnerId = normalizePlacementId(placements.first);
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
  }

  // No payouts for second or third place - winner takes all

  logger.info(
    { seasonId, tournamentId, platformFee, firstAmount, draw: isDraw, skipPayout },
    '[seasonCompletion] Payouts completed (winner takes all)'
  );

  await prisma.season.updateMany({
    where: { seasonId, tournamentId, status: { not: 'completed' } },
    data: {
      status: 'completed',
      completedAt: endedAt ? new Date(endedAt) : new Date(),
      finalMatchId: payload?.finalMatchId || null,
      finalizedByJobId: payload?.finalizedByJobId || null,
      errorReason: null
    }
  });

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
