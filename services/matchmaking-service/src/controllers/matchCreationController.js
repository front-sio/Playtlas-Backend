// services/matchmaking-service/src/controllers/matchCreationController.js
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, publishEvent, Topics } = require('../../../../shared/events');
const { completeMatchAndProgress } = require('./matchmakingController');
const { getIO } = require('../utils/socket');
const axios = require('axios');

const BYE_PLAYER_ID = '00000000-0000-0000-0000-000000000000';
const GROUP_SIZE = Number(process.env.GROUP_SIZE || 4);
const GROUP_QUALIFIERS = Number(process.env.GROUP_QUALIFIERS || 2);
const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.MATCH_DURATION_SECONDS || 300);
const MAX_PARALLEL_MATCHES = Number(process.env.MATCH_MAX_PARALLEL || 5);
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:3000';

function getInitialStage(playerCount) {
  if (playerCount <= 2) return 'final';
  if (playerCount <= 4) return 'semifinal';
  if (playerCount <= 8) return 'quarterfinal';
  if (playerCount <= 16) return 'round_of_16';
  return 'round_of_32';
}

function getBracketRounds(playerCount) {
  if (playerCount <= 1) return 0;
  return Math.ceil(Math.log2(playerCount));
}

function estimateSeasonEndTime(startTime, playerCount, isGroupStage, matchDurationSeconds) {
  const durationMs = matchDurationSeconds * 1000;
  let totalSlots = 0;
  if (isGroupStage) {
    const groups = Math.ceil(playerCount / GROUP_SIZE);
    const baseGroupSize = Math.ceil(playerCount / groups);
    const totalMatches = groups * (baseGroupSize * (baseGroupSize - 1) / 2);
    totalSlots = Math.ceil(totalMatches / MAX_PARALLEL_MATCHES);
  } else {
    const rounds = getBracketRounds(playerCount);
    const bracketSize = 2 ** rounds;
    for (let round = 1; round <= rounds; round += 1) {
      const matches = bracketSize / 2 ** round;
      totalSlots += Math.ceil(matches / MAX_PARALLEL_MATCHES);
    }
  }
  const endMs = startTime.getTime() + totalSlots * durationMs + 30000;
  return new Date(endMs);
}

async function getRoundStartTime(seasonId, roundNumber, fallbackStart, matchDurationSeconds) {
  if (roundNumber <= 1 && fallbackStart) {
    return fallbackStart;
  }

  const durationMs = matchDurationSeconds * 1000;
  const lastMatch = await prisma.match.findFirst({
    where: {
      seasonId,
      roundNumber: { lt: roundNumber },
      scheduledTime: { not: null }
    },
    orderBy: { scheduledTime: 'desc' }
  });
  if (lastMatch?.scheduledTime) {
    return new Date(new Date(lastMatch.scheduledTime).getTime() + durationMs);
  }
  return fallbackStart || new Date(Date.now() + 60000);
}

async function refundSeasonEntryFees({ tournamentId, seasonId, playerIds }) {
  if (!playerIds.length) return;

  const tournament = await prisma.tournament.findUnique({
    where: { tournamentId },
    select: { entryFee: true }
  });
  const entryFee = Number(tournament?.entryFee || 0);
  if (entryFee <= 0) return;

  const systemWalletRes = await axios.get(`${WALLET_SERVICE_URL}/system/wallet`, { timeout: 10000 });
  const systemWalletId = systemWalletRes.data?.data?.walletId || systemWalletRes.data?.walletId;
  if (!systemWalletId) {
    logger.warn('[refund] System wallet not found; skipping refunds');
    return;
  }

  for (const playerId of playerIds) {
    try {
      const walletRes = await axios.get(`${WALLET_SERVICE_URL}/owner/${playerId}`, { timeout: 10000 });
      const walletId = walletRes.data?.data?.walletId || walletRes.data?.walletId;
      if (!walletId) continue;

      await axios.post(`${WALLET_SERVICE_URL}/transfer`, {
        fromWalletId: systemWalletId,
        toWalletId: walletId,
        amount: entryFee,
        description: 'Season cancelled refund',
        metadata: { tournamentId, seasonId },
        idempotencyKey: `season_refund:${seasonId}:${playerId}`
      }, { timeout: 10000 });

      await publishEvent(Topics.NOTIFICATION_SEND, {
        userId: playerId,
        channel: 'in_app',
        type: 'season_refund',
        title: 'Season cancelled',
        message: `Season ${seasonId} cancelled due to insufficient players. Your entry fee was refunded.`
      }).catch((err) => {
        logger.error({ err, playerId, seasonId }, '[refund] Failed to publish refund notification');
      });
    } catch (error) {
      logger.error({ err: error, playerId, seasonId }, '[refund] Failed to refund entry fee');
    }
  }
}

async function cancelSeasonForInsufficientPlayers({ tournamentId, seasonId, playerIds }) {
  const now = new Date();
  if (prisma.season && prisma.season.update) {
    await prisma.season.update({
      where: { seasonId },
      data: {
        status: 'cancelled',
        endTime: now,
        matchesGenerated: false,
        joiningClosed: true
      }
    });
  } else {
    logger.warn({ seasonId }, '[cancelSeason] Season model not available in matchmaking DB; skipping season update');
  }

  await refundSeasonEntryFees({ tournamentId, seasonId, playerIds });

  const io = getIO();
  if (io) {
    io.to(`season:${seasonId}`).emit('season:ended', {
      tournamentId,
      seasonId,
      endedAt: now.toISOString(),
      reason: 'insufficient_players'
    });
  }
}

/**
 * A more generic function to create matches for various scenarios.
 * @param {Array<string>} players - An array of player IDs.
 * @param {object} options - Additional options for match creation.
 * @param {string} [options.tournamentId] - The ID of the tournament.
 * @param {string} [options.seasonId] - The ID of the season.
 * @param {number} [options.stage] - The tournament stage.
 * @param {number} [options.roundNumber=1] - The round number.
 */
async function createMatches(players, options = {}) {
  logger.info('Creating matches', { players, options });

  const { seasonStartTime: rawSeasonStartTime, matchDurationSeconds: rawMatchDurationSeconds, ...matchOptions } = options;
  const matchDurationSeconds = Number(rawMatchDurationSeconds || DEFAULT_MATCH_DURATION_SECONDS);

  // TODO: Implement skill-based seeding for better match quality
  // For now, we shuffle players to randomize pairings
  const seededPlayers = [...players].sort(() => Math.random() - 0.5);

  const createdMatches = [];
  const seasonStartTime = rawSeasonStartTime ? new Date(rawSeasonStartTime) : null;
  const roundNumber = Number(matchOptions.roundNumber || 1);
  const durationMs = matchDurationSeconds * 1000;
  const roundStartTime = matchOptions.seasonId
    ? await getRoundStartTime(matchOptions.seasonId, roundNumber, seasonStartTime, matchDurationSeconds)
    : new Date(Date.now() + 60000);

  for (let i = 0; i < seededPlayers.length - 1; i += 2) {
    const player1Id = seededPlayers[i];
    const player2Id = seededPlayers[i + 1];
    const matchIndex = Math.floor(i / 2);
    const slotIndex = Math.floor(matchIndex / MAX_PARALLEL_MATCHES);
    const scheduledTime = new Date(roundStartTime.getTime() + slotIndex * durationMs);

    const matchData = {
      player1Id,
      player2Id,
      status: 'scheduled',
      scheduledTime,
      metadata: { matchDurationSeconds },
      ...matchOptions,
    };

    const match = await prisma.match.create({ data: matchData });
    createdMatches.push(match);
  }

  // Handle odd number of players
  if (seededPlayers.length % 2 === 1) {
    const byePlayer = seededPlayers[seededPlayers.length - 1];
    logger.info('Player gets a bye due to odd count', { byePlayer, options });
    const byeMatch = await prisma.match.create({
      data: {
        player1Id: byePlayer,
        player2Id: BYE_PLAYER_ID,
        status: 'completed',
        scheduledTime: new Date(),
        completedAt: new Date(),
        winnerId: byePlayer,
        metadata: { bye: true, matchDurationSeconds },
        ...matchOptions
      }
    });
    createdMatches.push(byeMatch);
  }

  logger.info('Matches created successfully', { count: createdMatches.length, options });
  return createdMatches;
}

function chunkPlayers(players, size) {
  const groups = [];
  for (let i = 0; i < players.length; i += size) {
    groups.push(players.slice(i, i + size));
  }
  return groups;
}

async function createGroupStageMatches(players, options = {}) {
  logger.info('Creating group stage matches', { playerCount: players.length, options });

  const { seasonStartTime: rawSeasonStartTime, matchDurationSeconds: rawMatchDurationSeconds, ...matchOptions } = options;
  const matchDurationSeconds = Number(rawMatchDurationSeconds || DEFAULT_MATCH_DURATION_SECONDS);
  const seasonStartTime = rawSeasonStartTime ? new Date(rawSeasonStartTime) : null;
  const durationMs = matchDurationSeconds * 1000;
  const roundStartTime = matchOptions.seasonId
    ? await getRoundStartTime(matchOptions.seasonId, 1, seasonStartTime, matchDurationSeconds)
    : new Date(Date.now() + 60000);

  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const groups = chunkPlayers(shuffled, GROUP_SIZE);
  const createdMatches = [];

  for (let index = 0; index < groups.length; index += 1) {
    const groupPlayers = groups[index];
    const groupLabel = String.fromCharCode(65 + index);
    const groupId = `${options.seasonId || 'season'}-group-${groupLabel}`;

    for (let i = 0; i < groupPlayers.length; i += 1) {
      for (let j = i + 1; j < groupPlayers.length; j += 1) {
        const player1Id = groupPlayers[i];
        const player2Id = groupPlayers[j];
        const match = await prisma.match.create({
          data: {
            player1Id,
            player2Id,
            status: 'scheduled',
            scheduledTime: new Date(roundStartTime.getTime() + Math.floor(createdMatches.length / MAX_PARALLEL_MATCHES) * durationMs),
            metadata: { groupId, groupLabel, matchDurationSeconds },
            ...matchOptions
          }
        });
        createdMatches.push(match);
      }
    }
  }

  logger.info('Group stage matches created', { count: createdMatches.length, groupCount: groups.length });
  return createdMatches;
}

async function handleTournamentMatchGeneration(data) {
  const { tournamentId, seasonId, players, stage, matchDurationSeconds: rawMatchDurationSeconds } = data;
  if (!tournamentId || !seasonId || !Array.isArray(players)) {
    logger.warn({ data }, 'Invalid tournament match generation payload');
    return;
  }

  const uniquePlayers = Array.from(new Set(players.filter((p) => typeof p === 'string' && p.length > 0)));
  if (uniquePlayers.length < 2) {
    logger.warn({ tournamentId, seasonId, playerCount: uniquePlayers.length }, 'Not enough players to generate matches');
    await cancelSeasonForInsufficientPlayers({ tournamentId, seasonId, playerIds: uniquePlayers });
    return;
  }

  const normalizedStage = typeof stage === 'string' ? stage : '';
  const matchDurationSeconds = Number(rawMatchDurationSeconds || DEFAULT_MATCH_DURATION_SECONDS);
  const options = { tournamentId, seasonId, stage: normalizedStage || undefined, roundNumber: 1, matchDurationSeconds };
  const useGroupStage = normalizedStage === 'group' && uniquePlayers.length >= GROUP_SIZE;
  const effectiveStage = useGroupStage ? 'group' : getInitialStage(uniquePlayers.length);
  const seasonStartTime = data.startTime ? new Date(data.startTime) : new Date();

  const matches = useGroupStage
    ? await createGroupStageMatches(uniquePlayers, { ...options, stage: 'group', seasonStartTime })
    : await createMatches(uniquePlayers, { ...options, stage: effectiveStage, seasonStartTime });

  const io = getIO();
  if (io) {
    const payload = {
      tournamentId,
      seasonId,
      stage: effectiveStage,
      roundNumber: 1,
      matches
    };
    io.to(`season:${seasonId}`).emit('season:matches_generated', payload);
    io.to(`tournament:${tournamentId}`).emit('season:matches_generated', payload);
  }
}

async function handleSeasonCompleted(data) {
  const { tournamentId, seasonId, endedAt } = data || {};
  if (!tournamentId || !seasonId) {
    logger.warn({ data }, 'Invalid season completed payload');
    return;
  }

  if (prisma.matchQueue) {
    await prisma.matchQueue.deleteMany({
      where: { tournamentId, seasonId }
    });
  }

  await prisma.match.updateMany({
    where: {
      tournamentId,
      seasonId,
      status: { notIn: ['completed', 'cancelled'] }
    },
    data: {
      status: 'cancelled',
      metadata: {
        reason: 'season_completed',
        endedAt: endedAt || new Date().toISOString()
      }
    }
  });

  const io = getIO();
  if (io) {
    io.to(`season:${seasonId}`).emit('season:ended', {
      tournamentId,
      seasonId,
      endedAt: endedAt || new Date().toISOString()
    });
  }
}

exports.createP2PMatch = async (player1Id, player2Id) => {
    return createMatches([player1Id, player2Id], {});
};

exports.initializeTournamentEventConsumer = () => {
  let attempt = 0;

  const startConsumer = async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await subscribeEvents(
          'matchmaking-service',
          [Topics.GENERATE_MATCHES, Topics.SEASON_COMPLETED, Topics.MATCH_RESULT],
          (topic, data) => {
            if (topic === Topics.GENERATE_MATCHES) {
              logger.info('Received GENERATE_MATCHES event', { tournamentId: data?.tournamentId, seasonId: data?.seasonId, playerCount: data?.players?.length });
              handleTournamentMatchGeneration(data).catch(error => {
                logger.error('Failed to process GENERATE_MATCHES event:', error);
              });
              return;
            }
            if (topic === Topics.SEASON_COMPLETED) {
              logger.info('Received SEASON_COMPLETED event', { tournamentId: data?.tournamentId, seasonId: data?.seasonId });
              handleSeasonCompleted(data).catch(error => {
                logger.error('Failed to process SEASON_COMPLETED event:', error);
              });
              return;
            }
            if (topic === Topics.MATCH_RESULT) {
              logger.info('Received MATCH_RESULT event', { matchId: data?.matchId, winnerId: data?.winnerId });
              completeMatchAndProgress({
                matchId: data.matchId,
                winnerId: data.winnerId,
                player1Score: data.player1Score,
                player2Score: data.player2Score
              }).catch((error) => {
                logger.error('Failed to process MATCH_RESULT event:', error);
              });
            }
          }
        );

        logger.info('[matchmaking-consumer] Kafka consumer subscribed');
        return;
      } catch (err) {
        attempt += 1;
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
        logger.error({ err, attempt, delay }, '[matchmaking-consumer] Failed to subscribe to Kafka, retrying');
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  startConsumer().catch((err) => {
    logger.error({ err }, '[matchmaking-consumer] Unexpected consumer startup error');
  });
};

exports.createMatches = createMatches;
