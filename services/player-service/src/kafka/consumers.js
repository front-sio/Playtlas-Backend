const logger = require('../utils/logger');
const { Topics, subscribeEvents } = require('../../../../shared/events');
const { ensurePlayerProfile } = require('../services/playerProfileService');
const { prisma } = require('../config/db');
const { Prisma } = require('@prisma/client');

const MATCHMAKING_SERVICE_URL = process.env.MATCHMAKING_SERVICE_URL || 'http://matchmaking-service:3009';

function logProcessingResult(topic, startTime, err) {
  const durationMs = Date.now() - startTime;
  if (err) {
    logger.error({ topic, durationMs, err }, '[player-consumers] Event processing failed');
    return;
  }
  if (durationMs > 2000) {
    logger.warn({ topic, durationMs }, '[player-consumers] Slow event processing');
  } else {
    logger.info({ topic, durationMs }, '[player-consumers] Event processed');
  }
}

async function handlePlayerRegistered(payload) {
  const { userId, username, agentUserId, clubId } = payload || {};

  if (!userId || !username) {
    logger.warn(
      { payload },
      '[player-consumers] PLAYER_REGISTERED missing userId or username'
    );
    return;
  }

  try {
    const { player, created } = await ensurePlayerProfile({
      userId,
      username,
      agentUserId,
      clubId,
      activityAt: new Date()
    });

    logger.info(
      { playerId: player.playerId, created },
      '[player-consumers] Player profile ensured from PLAYER_REGISTERED event'
    );
  } catch (error) {
    logger.error(
      { err: error, payload },
      '[player-consumers] Failed to ensure player profile from event'
    );
  }
}

async function fetchMatchDetails(matchId) {
  try {
    const response = await fetch(`${MATCHMAKING_SERVICE_URL}/matchmaking/match/${encodeURIComponent(matchId)}`);
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.data?.match || payload?.match || null;
  } catch (err) {
    logger.error({ err, matchId }, '[player-consumers] Failed to fetch match details');
    return null;
  }
}

async function applyMatchResult({ playerId, matchId, tournamentId, opponentId, result, matchData }) {
  const normalizedResult = String(result).toLowerCase();
  const isWin = normalizedResult === 'win';

  await prisma.$transaction(async (tx) => {
    const existing = await tx.matchHistory.findFirst({
      where: { playerId, matchId }
    });
    if (existing) return;

    const current = await tx.playerStat.findUnique({ where: { playerId } });
    if (!current) {
      throw new Error('Player not found');
    }

    await tx.matchHistory.create({
      data: {
        playerId,
        matchId,
        tournamentId,
        opponentId,
        result: normalizedResult,
        pointsChange: 0,
        matchData: matchData ?? undefined
      }
    });

    const totalMatches = current.totalMatches + 1;
    const matchesWon = current.matchesWon + (isWin ? 1 : 0);
    const matchesLost = current.matchesLost + (isWin ? 0 : 1);
    const currentStreak = isWin ? current.currentStreak + 1 : 0;
    const longestStreak = isWin ? Math.max(current.longestStreak, currentStreak) : current.longestStreak;
    const rankingPoints = current.rankingPoints;
    const winRate = totalMatches > 0 ? (matchesWon / totalMatches) * 100 : 0;

    await tx.playerStat.update({
      where: { playerId },
      data: {
        totalMatches,
        matchesWon,
        matchesLost,
        currentStreak,
        longestStreak,
        rankingPoints,
        winRate: new Prisma.Decimal(winRate.toFixed(2)),
        updatedAt: new Date(),
        lastActivityAt: new Date()
      }
    });
  });
}

async function handleMatchCompleted(payload) {
  const { tournamentId, matchId, winnerId, loserId, stage, roundNumber, seasonId } = payload || {};
  if (!tournamentId || !matchId || !winnerId || !loserId) {
    logger.warn({ payload }, '[player-consumers] MATCH_COMPLETED missing required fields');
    return;
  }

  const match = await fetchMatchDetails(matchId);
  const matchData = {
    tournamentId,
    seasonId,
    stage,
    roundNumber,
    winnerId,
    loserId,
    player1Score: match?.player1Score,
    player2Score: match?.player2Score,
    player1Id: match?.player1Id,
    player2Id: match?.player2Id
  };

  try {
    await applyMatchResult({
      playerId: winnerId,
      matchId,
      tournamentId,
      opponentId: loserId,
      result: 'win',
      matchData
    });
  } catch (err) {
    if (err?.message !== 'Player not found') {
      logger.error({ err, matchId, playerId: winnerId }, '[player-consumers] Failed to apply win result');
    }
  }

  try {
    await applyMatchResult({
      playerId: loserId,
      matchId,
      tournamentId,
      opponentId: winnerId,
      result: 'loss',
      matchData
    });
  } catch (err) {
    if (err?.message !== 'Player not found') {
      logger.error({ err, matchId, playerId: loserId }, '[player-consumers] Failed to apply loss result');
    }
  }
}

async function startPlayerConsumers() {
  let attempt = 0;
  // Keep retrying so event-driven profile creation resumes if Kafka starts late.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await subscribeEvents(
        'player-service',
        [Topics.PLAYER_REGISTERED, Topics.MATCH_COMPLETED],
        async (topic, payload) => {
          const startTime = Date.now();
          try {
            if (topic === Topics.PLAYER_REGISTERED) {
              await handlePlayerRegistered(payload);
            }
            if (topic === Topics.MATCH_COMPLETED) {
              await handleMatchCompleted(payload);
            }
            logProcessingResult(topic, startTime);
          } catch (err) {
            logProcessingResult(topic, startTime, err);
          }
        }
      );

      logger.info('[player-consumers] Kafka consumers started');
      return;
    } catch (err) {
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
      logger.error({ err, attempt, delay }, '[player-consumers] Failed to subscribe to Kafka, retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = {
  startPlayerConsumers
};
