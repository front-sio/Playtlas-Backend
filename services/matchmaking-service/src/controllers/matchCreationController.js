// services/matchmaking-service/src/controllers/matchCreationController.js
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, Topics } = require('../../../../shared/events');
const { completeMatchAndProgress } = require('./matchmakingController');
const { getIO } = require('../utils/socket');

const BYE_PLAYER_ID = '00000000-0000-0000-0000-000000000000';
const GROUP_SIZE = Number(process.env.GROUP_SIZE || 4);
const GROUP_QUALIFIERS = Number(process.env.GROUP_QUALIFIERS || 2);

function getInitialStage(playerCount) {
  if (playerCount <= 2) return 'final';
  if (playerCount <= 4) return 'semifinal';
  if (playerCount <= 8) return 'quarterfinal';
  if (playerCount <= 16) return 'round_of_16';
  return 'round_of_32';
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

  // TODO: Implement skill-based seeding for better match quality
  // For now, we shuffle players to randomize pairings
  const seededPlayers = [...players].sort(() => Math.random() - 0.5);

  const createdMatches = [];
  for (let i = 0; i < seededPlayers.length - 1; i += 2) {
    const player1Id = seededPlayers[i];
    const player2Id = seededPlayers[i + 1];

    const matchData = {
      player1Id,
      player2Id,
      status: 'scheduled',
      scheduledTime: new Date(Date.now() + 60000), // 1 minute from now
      ...options,
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
        metadata: { bye: true },
        ...options
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
            scheduledTime: new Date(Date.now() + 60000),
            metadata: { groupId, groupLabel },
            ...options
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
  const { tournamentId, seasonId, players, stage } = data;
  if (!tournamentId || !seasonId || !Array.isArray(players) || players.length < 2) {
    logger.warn({ data }, 'Invalid tournament match generation payload');
    return;
  }

  const uniquePlayers = Array.from(new Set(players.filter((p) => typeof p === 'string' && p.length > 0)));
  if (uniquePlayers.length < 2) {
    logger.warn({ tournamentId, seasonId, playerCount: uniquePlayers.length }, 'Not enough players to generate matches');
    return;
  }

  const normalizedStage = typeof stage === 'string' ? stage : '';
  const options = { tournamentId, seasonId, stage: normalizedStage || undefined, roundNumber: 1 };
  const useGroupStage = normalizedStage === 'group' && uniquePlayers.length >= GROUP_SIZE;
  const effectiveStage = useGroupStage ? 'group' : getInitialStage(uniquePlayers.length);
  const matches = useGroupStage
    ? await createGroupStageMatches(uniquePlayers, { ...options, stage: 'group' })
    : await createMatches(uniquePlayers, { ...options, stage: effectiveStage });

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
  subscribeEvents(
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

  logger.info('Tournament event consumer initialized');
};

exports.createMatches = createMatches;
