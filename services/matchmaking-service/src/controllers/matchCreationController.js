// services/matchmaking-service/src/controllers/matchCreationController.js
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, publishEvent, Topics } = require('../../../../shared/events');
const { getIO } = require('../utils/socket');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const BYE_PLAYER_ID = '00000000-0000-0000-0000-000000000000';
const GROUP_SIZE = Number(process.env.GROUP_SIZE || 4);
const GROUP_QUALIFIERS = Number(process.env.GROUP_QUALIFIERS || 2);
const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.MATCH_DURATION_SECONDS || 300);
const MAX_PARALLEL_MATCHES = Number(process.env.MATCH_MAX_PARALLEL || 5);
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:3000';
const PAYMENT_SERVICE_URL =
  process.env.PAYMENT_SERVICE_URL ||
  (process.env.API_GATEWAY_URL ? `${process.env.API_GATEWAY_URL}/api/payment` : null) ||
  'http://localhost:8081/api/payment';
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || 'http://localhost:3010';
const TOURNAMENT_SERVICE_URL = process.env.TOURNAMENT_SERVICE_URL || 'http://localhost:3005';
const SERVICE_JWT_TOKEN = process.env.SERVICE_JWT_TOKEN || process.env.PAYMENT_SERVICE_TOKEN;
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'http://localhost:3006';
const AGENT_CAPACITY = Number(process.env.AGENT_CAPACITY || 5);
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
    logger.error({ err }, '[refund] Failed to create service token');
    return null;
  }
}

// Only multiplayer mode is supported now
function normalizeGameType(value) {
  return 'multiplayer';
}

async function fetchAgentsForClub(clubId) {
  if (!clubId) return [];
  const serviceToken = getServiceToken();
  if (!serviceToken) {
    logger.warn('[matchmaking] Missing service token; cannot fetch agents for club');
    return [];
  }
  try {
    const response = await axios.get(`${AGENT_SERVICE_URL}/internal/agents`, {
      params: { clubId, limit: 200, offset: 0, status: 'online' },
      headers: { Authorization: `Bearer ${serviceToken}` },
      timeout: 10000
    });
    return response.data?.data || [];
  } catch (error) {
    logger.error({ err: error, clubId }, '[matchmaking] Failed to fetch agents for club');
    return [];
  }
}

async function fetchDevicesForClub(clubId) {
  if (!clubId) return [];
  const serviceToken = getServiceToken();
  if (!serviceToken) {
    logger.warn('[matchmaking] Missing service token; cannot fetch devices for club');
    return [];
  }
  try {
    const response = await axios.get(`${AGENT_SERVICE_URL}/internal/devices`, {
      params: { clubId, status: 'online' },
      headers: { Authorization: `Bearer ${serviceToken}` },
      timeout: 10000
    });
    return response.data?.data || [];
  } catch (error) {
    logger.error({ err: error, clubId }, '[matchmaking] Failed to fetch devices for club');
    return [];
  }
}

function buildDevicesByAgent(devices) {
  const map = new Map();
  (devices || []).forEach((device) => {
    if (!device?.agentId || !device?.deviceId) return;
    if (!map.has(device.agentId)) map.set(device.agentId, []);
    map.get(device.agentId).push(device);
  });
  return map;
}

async function fetchTournamentDetails(tournamentId) {
  if (!tournamentId) return null;
  const serviceToken = getServiceToken();
  try {
    const response = await axios.get(`${TOURNAMENT_SERVICE_URL}/tournament/${tournamentId}`, {
      headers: serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {},
      timeout: 5000
    });
    return response.data?.data || null;
  } catch (error) {
    logger.error({ err: error, tournamentId }, '[matchmaking] Failed to fetch tournament details');
    return null;
  }
}

function pickDevice({ devicesByAgent, allDevices, assignedAgent, matchIndex }) {
  const agentDevices = assignedAgent ? devicesByAgent.get(assignedAgent.agentId) || [] : [];
  const pool = agentDevices.length ? agentDevices : allDevices;
  if (!pool || !pool.length) return null;
  return pool[matchIndex % pool.length];
}

function scheduleMatchTime({ matchIndex, roundStartTime, durationMs, agents }) {
  const availableAgents = Array.isArray(agents) ? agents : [];
  if (!availableAgents.length) {
    const slotIndex = Math.floor(matchIndex / MAX_PARALLEL_MATCHES);
    return {
      scheduledTime: new Date(roundStartTime.getTime() + slotIndex * durationMs),
      assignedAgent: null
    };
  }

  const slotSize = Math.max(1, availableAgents.length * AGENT_CAPACITY);
  const slotIndex = Math.floor(matchIndex / slotSize);
  const indexInSlot = matchIndex % slotSize;
  const agentIndex = Math.floor(indexInSlot / AGENT_CAPACITY);
  const assignedAgent = availableAgents[agentIndex] || null;
  return {
    scheduledTime: new Date(roundStartTime.getTime() + slotIndex * durationMs),
    assignedAgent
  };
}

async function getRoundStartTime(seasonId, roundNumber, seasonStartTime, matchDurationSeconds) {
  if (!seasonId) return new Date(Date.now() + 60000);

  // If it's the first round, use season start time or now + buffer
  if (roundNumber <= 1) {
    return seasonStartTime && seasonStartTime > new Date()
      ? seasonStartTime
      : new Date(Date.now() + 60000);
  }

  // For subsequent rounds, we need to estimate when the previous round finishes.
  // This is a simplified estimation. In a real system, we might check actual match completions.
  // Here we assume each round takes (matchDurationSeconds + 60s buffer) * matches_per_agent / parallel_factor?
  // Let's keep it simple: Round N starts after Round N-1 duration.
  // We can query the database for the latest scheduled time of the previous round?
  // Or just calculate based on structure.

  // Let's fetch the latest scheduled match for the previous round in this season
  try {
    const lastRoundMatch = await prisma.match.findFirst({
      where: { seasonId, metadata: { path: ['roundNumber'], equals: roundNumber - 1 } },
      orderBy: { scheduledTime: 'desc' }
    });

    if (lastRoundMatch && lastRoundMatch.scheduledTime) {
      // Start next round 5 minutes after the last match of previous round
      return new Date(new Date(lastRoundMatch.scheduledTime).getTime() + (matchDurationSeconds * 1000) + 300000);
    }
  } catch (e) {
    logger.warn({ err: e, seasonId }, 'Failed to fetch previous round info, falling back to estimation');
  }

  // Fallback: Estimate based on round number
  // Assume each round takes ~1 hour (very rough) or just stack them
  const roundDurationMs = (matchDurationSeconds * 1000) * 2; // Allow double duration for buffer
  const baseTime = seasonStartTime || new Date();
  return new Date(baseTime.getTime() + (roundNumber - 1) * roundDurationMs);
}

// Only the createGameSessionForMatch helper shown (full file contains more exports)
async function createGameSessionForMatch(match) {
  try {
    const matchMetadata = match?.metadata || {};
    const matchDurationSeconds = Number(matchMetadata.matchDurationSeconds || 300);

    // Only multiplayer sessions now - no AI mode
    const sessionEndpoint = 'multiplayer';

    const response = await axios.post(`${GAME_SERVICE_URL}/sessions/${sessionEndpoint}`, {
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      metadata: {
        matchId: match.matchId,
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        scheduledTime: match.scheduledTime,
        startTime: match.startedAt || match.scheduledTime,
        maxDurationSeconds: matchDurationSeconds,
        gameType: 'multiplayer',
        level: matchMetadata.level ?? null,
        instantSession: true, // Mark as instant session for realtime
        sessionStartTime: new Date().toISOString() // Session creation timestamp
      }
    }, { timeout: 10000 });

    const sessionId = response?.data?.data?.sessionId || response?.data?.data?.session?.sessionId;
    if (!sessionId) {
      logger.error('Failed to create game session: Missing sessionId from game-service response', { matchId: match.matchId });
      return null;
    }

    logger.info(`Game session created for match ${match.matchId}: ${sessionId} with realtime support`);
    return { sessionId };
  } catch (error) {
    logger.error({ err: error, matchId: match.matchId }, 'Failed to create game session for match');
    return null;
  }
}

function getInitialStage(playerCount) {
  if (playerCount <= 1) return null;
  const bracketSize = 2 ** Math.ceil(Math.log2(playerCount));
  if (bracketSize <= 2) return 'final';
  if (bracketSize <= 4) return 'semifinal';
  if (bracketSize <= 8) return 'quarterfinal';
  if (bracketSize <= 16) return 'round_of_16';
  return `round_of_${bracketSize}`;
}

function getBracketRounds(playerCount) {
  if (playerCount <= 1) return 0;
  return Math.ceil(Math.log2(playerCount));
}

function getFixturePlan(playerCount) {
  // For 2 players: direct final match
  if (playerCount === 2) {
    return { mode: 'knockout', groupCount: 0, initialStage: 'final' };
  }
  
  // For 3-11 players: knockout mode (no groups)
  if (playerCount < 12) {
    if (playerCount % 2 === 1) {
      return { mode: 'group', groupCount: 1, qualifiersPerGroup: 2, initialStage: 'group' };
    }
    const rounds = Math.ceil(Math.log2(playerCount));
    const bracketSize = 2 ** rounds;
    let initialStage = 'final';
    if (bracketSize === 4) initialStage = 'semifinal';
    if (bracketSize === 8) initialStage = 'quarterfinal';
    if (bracketSize === 16) initialStage = 'round_of_16';
    return { mode: 'knockout', groupCount: 0, initialStage };
  }

  // For 12+ players: use group stage
  if (playerCount <= 16) {
    return { mode: 'group', groupCount: 4, qualifiersPerGroup: 2, initialStage: 'quarterfinal' };
  }
  return { mode: 'group', groupCount: 8, qualifiersPerGroup: 2, initialStage: 'round_of_16' };
}

function pickHostPlayer({ player1Id, player2Id, matchIndex }) {
  return matchIndex % 2 === 0 ? player1Id : player2Id;
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

  const {
    seasonStartTime: rawSeasonStartTime,
    matchDurationSeconds: rawMatchDurationSeconds,
    entryFee: rawEntryFee,
    gameType,
    clubId,
    ...matchOptions
  } = options;
  const matchDurationSeconds = Number(rawMatchDurationSeconds || DEFAULT_MATCH_DURATION_SECONDS);
  const entryFee = Number(rawEntryFee || 0);
  const normalizedGameType = normalizeGameType(gameType);

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
  const agents = await fetchAgentsForClub(clubId);
  logger.info({ clubId, agentCount: agents.length }, '[matchmaking] Fetched agents for club');

  for (let i = 0; i < seededPlayers.length - 1; i += 2) {
    const player1Id = seededPlayers[i];
    const player2Id = seededPlayers[i + 1];
    const matchIndex = Math.floor(i / 2);
    const { scheduledTime, assignedAgent } = scheduleMatchTime({
      matchIndex,
      roundStartTime,
      durationMs,
      agents
    });
    const assignedHostPlayerUserId = pickHostPlayer({ player1Id, player2Id, matchIndex });

    const matchData = {
      player1Id,
      player2Id,
      status: 'scheduled',
      scheduledTime,
      scheduledStartAt: scheduledTime,
      clubId: clubId || null,
      assignedAgentId: null,
      assignedAgentUserId: null,
      assignedDeviceId: null,
      assignedHostPlayerUserId,
      hostAssignedAt: new Date(),
      verificationStatus: 'pending',
      verificationMethod: 'qr_ble',
      metadata: {
        matchDurationSeconds,
        maxDurationSeconds: 300,
        entryFee,
        gameType: normalizedGameType || null,
        hostAssignmentStrategy: 'alternating'
      },
      ...matchOptions,
    };

    const match = await prisma.match.create({ data: matchData });
    logger.info(
      {
        matchId: match.matchId,
        clubId: match.clubId,
        agentCount: agents.length,
        assignedHostPlayerUserId: match.assignedHostPlayerUserId
      },
      '[matchmaking] Match assigned to host player'
    );

    // Create game session immediately for each match
    try {
      const gameSession = await createGameSessionForMatch(match);
      if (gameSession) {
        await prisma.match.update({
          where: { matchId: match.matchId },
          data: { gameSessionId: gameSession.sessionId }
        });
        match.gameSessionId = gameSession.sessionId;
      }
    } catch (error) {
      logger.error({ err: error, matchId: match.matchId }, 'Failed to create game session for match');
    }

    createdMatches.push(match);
  }

  // Handle odd number of players
  if (seededPlayers.length % 2 === 1) {
    const byePlayer = seededPlayers[seededPlayers.length - 1];
    logger.info('Odd player count detected; no auto-advance bye created', { byePlayer, options });
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

function buildBalancedGroups(players, groupCount) {
  if (groupCount <= 0 || players.length === 0) return [];
  const baseSize = Math.floor(players.length / groupCount);
  const remainder = players.length % groupCount;
  const groups = [];
  let offset = 0;

  for (let i = 0; i < groupCount; i++) {
    const size = baseSize + (i < remainder ? 1 : 0);
    groups.push(players.slice(offset, offset + size));
    offset += size;
  }

  return groups;
}

async function cancelSeasonForInsufficientPlayers({ tournamentId, seasonId, playerIds }) {
  logger.warn(
    { tournamentId, seasonId, playerCount: playerIds?.length || 0 },
    '[matchmaking] Cancelling season due to insufficient players'
  );

  try {
    await publishEvent(Topics.SEASON_MATCHES_FAILED, {
      tournamentId,
      seasonId,
      error: 'Not enough players to generate matches',
      playerCount: playerIds?.length || 0,
      reason: 'insufficient_players'
    });
  } catch (err) {
    logger.error({ err, seasonId }, '[matchmaking] Failed to publish SEASON_MATCHES_FAILED event');
  }
}

async function createGroupStageMatches(players, options = {}) {
  logger.info('Creating group stage matches', { playerCount: players.length, options });

  const {
    seasonStartTime: rawSeasonStartTime,
    matchDurationSeconds: rawMatchDurationSeconds,
    entryFee: rawEntryFee,
    gameType,
    clubId,
    ...matchOptions
  } = options;
  const matchDurationSeconds = Number(rawMatchDurationSeconds || DEFAULT_MATCH_DURATION_SECONDS);
  const entryFee = Number(rawEntryFee || 0);
  const normalizedGameType = normalizeGameType(gameType);
  const seasonStartTime = rawSeasonStartTime ? new Date(rawSeasonStartTime) : null;
  const durationMs = matchDurationSeconds * 1000;
  const roundStartTime = matchOptions.seasonId
    ? await getRoundStartTime(matchOptions.seasonId, 1, seasonStartTime, matchDurationSeconds)
    : new Date(Date.now() + 60000);
  const agents = await fetchAgentsForClub(clubId);

  const providedGroups = Array.isArray(options.groups) && options.groups.length > 0 ? options.groups : null;
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const groups = providedGroups || chunkPlayers(shuffled, GROUP_SIZE);
  const createdMatches = [];

  for (let index = 0; index < groups.length; index += 1) {
    const groupPlayers = groups[index];
    const groupLabel = String.fromCharCode(65 + index);
    const groupId = `${options.seasonId || 'season'}-group-${groupLabel}`;

    for (let i = 0; i < groupPlayers.length; i += 1) {
      for (let j = i + 1; j < groupPlayers.length; j += 1) {
        const player1Id = groupPlayers[i];
        const player2Id = groupPlayers[j];
        const { scheduledTime, assignedAgent } = scheduleMatchTime({
          matchIndex: createdMatches.length,
          roundStartTime,
          durationMs,
          agents
        });
        const assignedHostPlayerUserId = pickHostPlayer({
          player1Id,
          player2Id,
          matchIndex: createdMatches.length
        });
        const match = await prisma.match.create({
          data: {
            player1Id,
            player2Id,
            status: 'scheduled',
            scheduledTime,
            scheduledStartAt: scheduledTime,
            clubId: clubId || null,
            bracketGroup: groupLabel,
            assignedAgentId: null,
            assignedAgentUserId: null,
            assignedDeviceId: null,
            assignedHostPlayerUserId,
            hostAssignedAt: new Date(),
            verificationStatus: 'pending',
            verificationMethod: 'qr_ble',
            metadata: {
              groupId,
              groupLabel,
              matchDurationSeconds,
              maxDurationSeconds: 300,
              entryFee,
              gameType: normalizedGameType || null,
              hostAssignmentStrategy: 'alternating'
            },
            ...matchOptions
          }
        });
        logger.info(
          {
            tournamentId: match.tournamentId,
            seasonId: match.seasonId,
            matchId: match.matchId,
            clubId: match.clubId,
            scheduledStartAt: match.scheduledStartAt,
            agentCount: agents.length,
            assignedHostPlayerUserId: match.assignedHostPlayerUserId
          },
          '[matchmaking] Match assigned to host player'
        );

        // Create game session immediately for each match
        try {
          const gameSession = await createGameSessionForMatch(match);
          if (gameSession) {
            await prisma.match.update({
              where: { matchId: match.matchId },
              data: { gameSessionId: gameSession.sessionId }
            });
            match.gameSessionId = gameSession.sessionId;
          }
        } catch (error) {
          logger.error({ err: error, matchId: match.matchId }, 'Failed to create game session for group match');
        }

        createdMatches.push(match);
      }
    }
  }

  logger.info('Group stage matches created', { count: createdMatches.length, groupCount: groups.length });
  return createdMatches;
}

async function handleTournamentMatchGeneration(data) {
  const {
    tournamentId,
    seasonId,
    clubId,
    players,
    stage,
    matchDurationSeconds: rawMatchDurationSeconds,
    entryFee: rawEntryFee,
    gameType
  } = data;
  if (!tournamentId || !seasonId || !Array.isArray(players)) {
    logger.warn({ data }, 'Invalid tournament match generation payload');
    return;
  }

  let effectiveClubId = clubId;
  if (!effectiveClubId) {
    logger.warn({ tournamentId }, '[matchmaking] clubId missing in payload; fetching from tournament-service');
    const tournament = await fetchTournamentDetails(tournamentId);
    if (tournament?.clubId) {
      effectiveClubId = tournament.clubId;
      logger.info({ tournamentId, effectiveClubId }, '[matchmaking] Resolved clubId from tournament-service');
    } else {
      logger.error({ tournamentId }, '[matchmaking] Failed to resolve clubId; matches will not be assigned to agents');
    }
  }

  const uniquePlayers = Array.from(new Set(players.filter((p) => typeof p === 'string' && p.length > 0)));
  if (uniquePlayers.length < 2) {
    logger.warn('Not enough players to generate matches', { tournamentId, seasonId, playerCount: uniquePlayers.length });
    await cancelSeasonForInsufficientPlayers({ tournamentId, seasonId, playerIds: uniquePlayers });
    return;
  }

  const matchDurationSeconds = Number(rawMatchDurationSeconds || DEFAULT_MATCH_DURATION_SECONDS);
  const normalizedGameType = normalizeGameType(gameType);
  const fixturePlan = getFixturePlan(uniquePlayers.length);
  const useGroupStage = fixturePlan.mode === 'group'; // Defined useGroupStage
  const options = {
    tournamentId,
    seasonId,
    clubId: effectiveClubId,
    roundNumber: 1,
    matchDurationSeconds,
    entryFee: Number(rawEntryFee || 0),
    gameType: normalizedGameType || undefined
  };
  const effectiveStage = fixturePlan.initialStage || getInitialStage(uniquePlayers.length);
  const seasonStartTime = data.startTime ? new Date(data.startTime) : new Date();

  let matches = [];
  try {
    const groupConfig = useGroupStage
      ? buildBalancedGroups(uniquePlayers, fixturePlan.groupCount || 1)
      : null;
    matches = useGroupStage
      ? await createGroupStageMatches(uniquePlayers, { ...options, stage: 'group', seasonStartTime, groups: groupConfig })
      : await createMatches(uniquePlayers, { ...options, stage: effectiveStage, seasonStartTime });
  } catch (err) {
    logger.error(
      { err, tournamentId, seasonId, playerCount: uniquePlayers.length },
      '[matchmaking] Match generation failed'
    );
    await publishEvent(Topics.SEASON_MATCHES_FAILED, {
      tournamentId,
      seasonId,
      error: err?.message || 'Match generation failed'
    }).catch((eventErr) => {
      logger.error({ err: eventErr, seasonId }, '[matchmaking] Failed to publish SEASON_MATCHES_FAILED');
    });
    return;
  }

  if (!matches.length) {
    logger.error(
      { tournamentId, seasonId, playerCount: uniquePlayers.length },
      '[matchmaking] Match generation produced zero matches'
    );
    await publishEvent(Topics.SEASON_MATCHES_FAILED, {
      tournamentId,
      seasonId,
      error: 'Match generation produced zero matches'
    }).catch((eventErr) => {
      logger.error({ err: eventErr, seasonId }, '[matchmaking] Failed to publish SEASON_MATCHES_FAILED');
    });
    return;
  }

  const scheduledCount = matches.filter((m) => m.scheduledStartAt || m.scheduledTime).length;
  await publishEvent(Topics.SEASON_MATCHES_GENERATED, {
    tournamentId,
    seasonId,
    stage: effectiveStage,
    matchesCreated: matches.length,
    scheduledCount
  }).catch((eventErr) => {
    logger.error({ err: eventErr, seasonId }, '[matchmaking] Failed to publish SEASON_MATCHES_GENERATED');
  });

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

    // Notify individual players about their matches
    for (const match of matches) {
      if (match.player1Id && match.player2Id) {
        try {
          await publishEvent(Topics.MATCH_READY, {
            matchId: match.matchId,
            tournamentId,
            seasonId,
            clubId: match.clubId || clubId || null,
            player1Id: match.player1Id,
            player2Id: match.player2Id,
            scheduledTime: match.scheduledTime?.toISOString(),
            scheduledStartAt: match.scheduledStartAt ? new Date(match.scheduledStartAt).toISOString() : null,
            assignedAgentId: match.assignedAgentId || null,
            assignedAgentUserId: match.assignedAgentUserId || null,
            assignedDeviceId: match.assignedDeviceId || null,
            assignedHostPlayerUserId: match.assignedHostPlayerUserId || null,
            verificationStatus: match.verificationStatus || null,
            stage: effectiveStage,
            roundNumber: 1,
            gameSessionId: match.gameSessionId,
            gameType: match.metadata?.gameType || 'multiplayer',
            withAi: false
          });
        } catch (eventError) {
          logger.error({ err: eventError, matchId: match.matchId }, 'Failed to publish MATCH_READY event');
        }
      }
    }
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
  const matches = await createMatches([player1Id, player2Id], {
    metadata: { maxDurationSeconds: 300 }
  });
  return matches;
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
              const { completeMatchAndProgress } = require('./matchmakingController');
              if (typeof completeMatchAndProgress !== 'function') {
                logger.error('completeMatchAndProgress is not available (circular dependency).');
                return;
              }
              const matchDurationSeconds = data?.matchDuration == null
                ? undefined
                : (Number.isFinite(Number(data.matchDuration)) ? Number(data.matchDuration) : undefined);
              completeMatchAndProgress({
                matchId: data.matchId,
                winnerId: data.winnerId,
                player1Score: data.player1Score,
                player2Score: data.player2Score,
                draw: data.draw,
                reason: data.reason,
                matchDuration: matchDurationSeconds,
                completedAt: data.completedAt
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
