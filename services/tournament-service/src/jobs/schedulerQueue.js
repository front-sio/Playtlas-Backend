const logger = require('../utils/logger');
const { prisma } = require('../config/db');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { createQueue, createWorker, defaultJobOptions } = require('../../../../shared/config/redis');
const { publishEvent, Topics } = require('../../../../shared/events');
const { emitSeasonUpdate } = require('../utils/socketEmitter');

const QUEUE_NAME = 'tournament-scheduler';

const JOIN_WINDOW_MINUTES = Number(process.env.SEASON_JOIN_WINDOW_MINUTES || 30);
const FIXTURE_DELAY_MINUTES = Number(process.env.SEASON_FIXTURE_DELAY_MINUTES || 4);
const SEASON_SCHEDULE_EVERY_MS = Number(process.env.SEASON_SCHEDULE_EVERY_MS || 5 * 60 * 1000);
const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.DEFAULT_MATCH_DURATION_SECONDS || 300);
const WITH_AI_SEASON_BUFFER = Number(process.env.WITH_AI_SEASON_BUFFER || 10);
const WITH_AI_INTERVAL_MINUTES = Number(process.env.WITH_AI_SEASON_INTERVAL_MINUTES || 1);
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3003';
const SERVICE_JWT_TOKEN = process.env.SERVICE_JWT_TOKEN || process.env.PAYMENT_SERVICE_TOKEN || null;
const AI_PLAYER_ID = process.env.AI_PLAYER_ID;
const AI_WALLET_OWNER_ID = process.env.AI_WALLET_OWNER_ID || AI_PLAYER_ID;
const AI_WALLET_TYPE = process.env.AI_WALLET_TYPE || 'ai';

let queue;
let worker;
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
    logger.error({ err }, '[scheduler] Failed to create service token');
    return null;
  }
}

function getQueue() {
  if (!queue) {
    queue = createQueue(QUEUE_NAME);
  }
  return queue;
}

function computeTimes(anchorTime, matchDurationSeconds) {
  const fixtureTime = new Date(anchorTime);
  const joiningCloseAt = new Date(
    fixtureTime.getTime() - FIXTURE_DELAY_MINUTES * 60 * 1000
  );
  const endTime = new Date(fixtureTime.getTime() + matchDurationSeconds * 1000);
  return { fixtureTime, joiningCloseAt, endTime };
}

function pad(num) {
  return String(num).padStart(2, '0');
}

function formatSeasonName(tournamentName, startTime) {
  const dt = new Date(startTime);
  const stamp = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  return `${tournamentName} ${stamp}`;
}

function normalizeGameType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'with_ai' || normalized === 'withai' || normalized === 'ai') {
    return 'with_ai';
  }
  return 'multiplayer';
}

async function createSeasonAndSchedule({ tournament, seasonNumber, startTime, matchDurationSeconds }) {
  const { fixtureTime, joiningCloseAt, endTime } = computeTimes(startTime, matchDurationSeconds);
  const season = await prisma.season.create({
    data: {
      tournamentId: tournament.tournamentId,
      seasonNumber,
      name: formatSeasonName(tournament.name, fixtureTime),
      status: 'upcoming',
      joiningClosed: false,
      matchesGenerated: false,
      startTime: fixtureTime,
      endTime
    }
  });

  await ensureAiParticipant({ tournament, season }).catch((err) => {
    logger.error({ err, seasonId: season.seasonId }, '[scheduler] Failed to register AI for season');
  });

  await emitSeasonUpdate({
    tournamentId: tournament.tournamentId,
    seasonId: season.seasonId,
    event: 'season_created'
  });

  const q = getQueue();
  await q.add(
    'close-season-joining',
    { seasonId: season.seasonId },
    {
      ...defaultJobOptions,
      jobId: `season:${season.seasonId}:close-joining`,
      delay: Math.max(0, joiningCloseAt.getTime() - Date.now())
    }
  );

  await q.add(
    'trigger-season-fixtures',
    { seasonId: season.seasonId },
    {
      ...defaultJobOptions,
      jobId: `season:${season.seasonId}:trigger-fixtures`,
      delay: Math.max(0, fixtureTime.getTime() - Date.now())
    }
  );

  await q.add(
    'complete-season',
    { seasonId: season.seasonId },
    {
      ...defaultJobOptions,
      jobId: `season:${season.seasonId}:complete`,
      delay: Math.max(0, endTime.getTime() - Date.now())
    }
  );

  logger.info(
    { tournamentId: tournament.tournamentId, seasonId: season.seasonId, joiningCloseAt, fixtureTime },
    '[scheduler] Season created and jobs scheduled'
  );

  return season;
}

async function fetchAiWallet() {
  if (!AI_WALLET_OWNER_ID) return null;
  try {
    const response = await axios.get(
      `${WALLET_SERVICE_URL}/owner/${encodeURIComponent(AI_WALLET_OWNER_ID)}?type=${encodeURIComponent(AI_WALLET_TYPE)}`,
      { timeout: 10000 }
    );
    return response.data?.data || null;
  } catch (err) {
    if (err.response?.status !== 404) {
      throw err;
    }
  }

  try {
    const response = await axios.get(
      `${WALLET_SERVICE_URL}/owner/${encodeURIComponent(AI_WALLET_OWNER_ID)}?type=player`,
      { timeout: 10000 }
    );
    return response.data?.data || null;
  } catch (err) {
    if (err.response?.status !== 404) {
      throw err;
    }
  }

  const createResponse = await axios.post(
    `${WALLET_SERVICE_URL}/create`,
    { userId: AI_WALLET_OWNER_ID, type: AI_WALLET_TYPE },
    { timeout: 10000 }
  );
  return createResponse.data?.data || null;
}

async function ensureAiParticipant({ tournament, season }) {
  const gameType = normalizeGameType(tournament?.metadata?.gameType);
  if (gameType !== 'with_ai') return;
  if (!AI_PLAYER_ID) {
    logger.warn({ tournamentId: tournament.tournamentId }, '[scheduler] AI player ID not configured');
    return;
  }

  const existing = await prisma.tournamentPlayer.findFirst({
    where: { seasonId: season.seasonId, playerId: AI_PLAYER_ID }
  });
  if (existing) return;

  let wallet;
  try {
    wallet = await fetchAiWallet();
  } catch (err) {
    logger.error(
      {
        seasonId: season.seasonId,
        message: err?.message,
        status: err?.response?.status,
        data: err?.response?.data
      },
      '[scheduler] Failed to fetch AI wallet'
    );
    return;
  }

  if (!wallet?.walletId) {
    logger.warn({ seasonId: season.seasonId }, '[scheduler] AI wallet missing; skipping auto-join');
    return;
  }

  const entryFee = Number(tournament.entryFee || 0);
  if (entryFee > 0) {
    const serviceToken = getServiceToken();
    if (!serviceToken) {
      logger.error({ seasonId: season.seasonId }, '[scheduler] SERVICE_JWT_TOKEN missing; cannot pay AI entry fee via payment-service');
      return;
    }
    try {
      await axios.post(
        `${PAYMENT_SERVICE_URL}/tournament-fee`,
        {
          playerWalletId: wallet.walletId,
          amount: entryFee,
          tournamentId: tournament.tournamentId,
          seasonId: season.seasonId,
          userId: AI_PLAYER_ID
        },
        {
          timeout: 10000,
          headers: {
            Authorization: `Bearer ${serviceToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (err) {
      logger.error(
        {
          seasonId: season.seasonId,
          message: err?.message,
          status: err?.response?.status,
          data: err?.response?.data
        },
        '[scheduler] AI fee payment failed (payment-service)'
      );
      return;
    }
  }

  await prisma.tournamentPlayer.create({
    data: {
      tournamentId: tournament.tournamentId,
      seasonId: season.seasonId,
      playerId: AI_PLAYER_ID,
      status: 'registered'
    }
  });
}



async function ensureNextSeason(tournamentId) {
  const tournament = await prisma.tournament.findUnique({
    where: { tournamentId },
    select: {
      tournamentId: true,
      status: true,
      matchDuration: true,
      stage: true,
      name: true,
      metadata: true,
      entryFee: true
    }
  });
  if (!tournament || tournament.status !== 'active') {
    return null;
  }

  const now = new Date();
  const gameType = normalizeGameType(tournament?.metadata?.gameType);
  const existingUpcomingCount = await prisma.season.count({
    where: {
      tournamentId,
      status: 'upcoming',
      startTime: { gt: now }
    }
  });

  const lastSeason = await prisma.season.findFirst({
    where: { tournamentId },
    orderBy: { seasonNumber: 'desc' },
    select: { seasonNumber: true, endTime: true, status: true }
  });

  const isLastSeasonFinal = ['completed', 'finished', 'cancelled'].includes(lastSeason?.status);
  if (gameType !== 'with_ai') {
    if (existingUpcomingCount > 0) {
      return null;
    }
    if (lastSeason && !isLastSeasonFinal && lastSeason.endTime && now <= new Date(lastSeason.endTime)) {
      return null;
    }
  } else if (existingUpcomingCount >= WITH_AI_SEASON_BUFFER) {
    return null;
  }

  const matchDurationSeconds = Number(tournament.matchDuration || DEFAULT_MATCH_DURATION_SECONDS);
  const nextSeasonNumber = lastSeason ? lastSeason.seasonNumber + 1 : 1;
  const minStartTime = new Date(now.getTime() + (JOIN_WINDOW_MINUTES + FIXTURE_DELAY_MINUTES) * 60 * 1000);

  if (gameType === 'with_ai') {
    const lastByStart = await prisma.season.findFirst({
      where: { tournamentId },
      orderBy: { startTime: 'desc' },
      select: { startTime: true }
    });
    const intervalMs = WITH_AI_INTERVAL_MINUTES * 60 * 1000;
    let startTime = minStartTime;
    if (lastByStart?.startTime) {
      const lastStartTime = new Date(lastByStart.startTime);
      if (lastStartTime >= minStartTime) {
        startTime = new Date(lastStartTime.getTime() + intervalMs);
      }
    }

    const seasonsToCreate = Math.max(0, WITH_AI_SEASON_BUFFER - existingUpcomingCount);
    let createdSeason = null;
    for (let i = 0; i < seasonsToCreate; i += 1) {
      const scheduledStart = new Date(startTime.getTime() + i * intervalMs);
      createdSeason = await createSeasonAndSchedule({
        tournament,
        seasonNumber: nextSeasonNumber + i,
        startTime: scheduledStart,
        matchDurationSeconds
      });
    }
    return createdSeason;
  }

  const anchorTime = lastSeason?.endTime && !isLastSeasonFinal
    ? new Date(lastSeason.endTime)
    : minStartTime;
  return createSeasonAndSchedule({
    tournament,
    seasonNumber: nextSeasonNumber,
    startTime: anchorTime,
    matchDurationSeconds
  });
}

async function closeSeasonJoining(seasonId) {
  const season = await prisma.season.findUnique({
    where: { seasonId },
    select: { seasonId: true, tournamentId: true, joiningClosed: true, status: true }
  });
  if (!season || season.joiningClosed) {
    return;
  }

  const tournament = await prisma.tournament.findUnique({
    where: { tournamentId: season.tournamentId },
    select: { status: true, metadata: true, entryFee: true, tournamentId: true, name: true }
  });
  if (!tournament || tournament.status !== 'active') {
    return;
  }

  await ensureAiParticipant({ tournament, season }).catch((err) => {
    logger.error({ err, seasonId: season.seasonId }, '[scheduler] Failed to register AI before join close');
  });

  await prisma.season.update({
    where: { seasonId },
    data: { joiningClosed: true }
  });
  logger.info({ seasonId }, '[scheduler] Season joining closed');

  const playerCount = await prisma.tournamentPlayer.count({
    where: { seasonId }
  });
  if (playerCount === 0 && season.status === 'upcoming') {
    await prisma.season.update({
      where: { seasonId },
      data: { status: 'cancelled' }
    });
    logger.info({ seasonId }, '[scheduler] Season cancelled due to no players');
    await emitSeasonUpdate({
      tournamentId: season.tournamentId,
      seasonId,
      event: 'season_cancelled'
    });
    await ensureNextSeason(season.tournamentId);
  }
}

async function triggerSeasonFixtures(seasonId) {
  const season = await prisma.season.findUnique({
    where: { seasonId },
    include: {
      tournament: { select: { tournamentId: true, status: true, stage: true, matchDuration: true, metadata: true } },
      tournamentPlayers: { select: { playerId: true, status: true } }
    }
  });
  if (!season) return;
  if (season.matchesGenerated) return;
  if (season.status !== 'upcoming') return;
  if (!season.tournament || season.tournament.status !== 'active') return;

  await ensureAiParticipant({ tournament: season.tournament, season }).catch((err) => {
    logger.error({ err, seasonId: season.seasonId }, '[scheduler] Failed to register AI before fixtures');
  });

  const refreshedPlayers = await prisma.tournamentPlayer.findMany({
    where: { seasonId },
    select: { playerId: true, status: true }
  });

  const activePlayers = refreshedPlayers
    .filter((p) => p.status !== 'eliminated')
    .map((p) => p.playerId);

  const tournamentStage =
    season.tournament.stage && season.tournament.stage !== 'registration'
      ? season.tournament.stage
      : 'group';
  const matchDurationSeconds = Number(season.tournament.matchDuration || DEFAULT_MATCH_DURATION_SECONDS);
  const seasonStartTime = season.startTime ? season.startTime.toISOString() : undefined;

  const gameType = normalizeGameType(season.tournament?.metadata?.gameType);
  const aiDifficulty = season.tournament?.metadata?.aiDifficulty ?? null;
  const aiPlayerId = gameType === 'with_ai' ? (AI_PLAYER_ID || null) : null;

  if (activePlayers.length < 2) {
    const now = new Date();
    await prisma.season.update({
      where: { seasonId },
      data: {
        status: 'cancelled',
        matchesGenerated: true,
        joiningClosed: true,
        endTime: now
      }
    });
    logger.info({ seasonId, playerCount: activePlayers.length }, '[scheduler] Season cancelled due to insufficient players');
    await emitSeasonUpdate({
      tournamentId: season.tournament.tournamentId,
      seasonId,
      event: 'season_cancelled'
    });
    await publishEvent(
      Topics.GENERATE_MATCHES,
      {
        tournamentId: season.tournament.tournamentId,
        seasonId,
        stage: tournamentStage,
        players: activePlayers,
        matchDurationSeconds,
        startTime: seasonStartTime,
        gameType,
        aiDifficulty,
        aiPlayerId
      },
      season.seasonId
    ).catch((err) => {
      logger.error({ err, seasonId }, '[scheduler] Failed to publish GENERATE_MATCHES for refund');
    });
    return;
  }

  // Activate season at fixture time.
  await prisma.season.update({
    where: { seasonId },
    data: { status: 'active', matchesGenerated: true }
  });

  await publishEvent(
    Topics.GENERATE_MATCHES,
    {
      tournamentId: season.tournament.tournamentId,
      seasonId: season.seasonId,
      stage: tournamentStage,
      players: activePlayers,
      matchDurationSeconds,
      startTime: seasonStartTime,
      gameType,
      aiDifficulty,
      aiPlayerId
    },
    season.seasonId
  );

  logger.info(
    { seasonId, playerCount: activePlayers.length },
    '[scheduler] Published GENERATE_MATCHES and activated season'
  );
}

async function ensureTournamentSchedule(tournamentId) {
  const q = getQueue();
  const repeatableJobs = await q.getRepeatableJobs();
  const repeatableId = `tournament:${tournamentId}:ensure-next-season`;
  const hasRepeatable = repeatableJobs.some((job) => job.id === repeatableId);
  if (!hasRepeatable) {
    await q.add(
      'ensure-next-season',
      { tournamentId },
      {
        ...defaultJobOptions,
        jobId: repeatableId,
        repeat: { every: SEASON_SCHEDULE_EVERY_MS }
      }
    );
  }

  // Also run once immediately to seed first season.
  try {
    await q.remove(`tournament:${tournamentId}:ensure-next-season-once`);
  } catch (err) {
    // ignore missing jobs
  }
  await q.add(
    'ensure-next-season-once',
    { tournamentId },
    {
      ...defaultJobOptions,
      jobId: `tournament:${tournamentId}:ensure-next-season-once`
    }
  );
}

async function ensureActiveTournamentSchedules() {
  const activeTournaments = await prisma.tournament.findMany({
    where: { status: 'active' },
    select: { tournamentId: true }
  });

  if (!activeTournaments.length) {
    logger.info('[scheduler] No active tournaments to schedule');
    return;
  }

  for (const tournament of activeTournaments) {
    try {
      await ensureTournamentSchedule(tournament.tournamentId);
      logger.info({ tournamentId: tournament.tournamentId }, '[scheduler] Active tournament schedule ensured');
    } catch (err) {
      logger.error({ err, tournamentId: tournament.tournamentId }, '[scheduler] Failed to ensure active tournament schedule');
    }
  }
}

async function cancelTournamentSchedule(tournamentId) {
  const q = getQueue();

  const removeJobSafe = async (jobId) => {
    if (!jobId) return;
    try {
      await q.remove(jobId);
    } catch (err) {
      // ignore missing jobs
    }
  };

  await removeJobSafe(`tournament:${tournamentId}:ensure-next-season-once`);
  await removeJobSafe(`tournament:${tournamentId}:start`);

  try {
    const repeatable = await q.getRepeatableJobs();
    for (const job of repeatable) {
      if (job.id === `tournament:${tournamentId}:ensure-next-season`) {
        await q.removeRepeatableByKey(job.key);
      }
    }
  } catch (err) {
    logger.warn({ err, tournamentId }, '[scheduler] Failed to remove repeatable jobs');
  }

  const seasons = await prisma.season.findMany({
    where: {
      tournamentId,
      status: { in: ['upcoming', 'active'] }
    },
    select: { seasonId: true }
  });

  for (const season of seasons) {
    await removeJobSafe(`season:${season.seasonId}:close-joining`);
    await removeJobSafe(`season:${season.seasonId}:trigger-fixtures`);
  await removeJobSafe(`season:${season.seasonId}:complete`);
  }

  logger.info({ tournamentId }, '[scheduler] Tournament schedule cancelled');
}

async function scheduleTournamentStart(tournamentId, startTime) {
  if (!startTime) return;
  const q = getQueue();
  const jobId = `tournament:${tournamentId}:start`;

  try {
    await q.remove(jobId);
  } catch (err) {
    // ignore if job does not exist
  }

  const delay = Math.max(0, new Date(startTime).getTime() - Date.now());
  await q.add(
    'start-tournament',
    { tournamentId },
    {
      ...defaultJobOptions,
      jobId,
      delay
    }
  );
}

async function startTournament(tournamentId) {
  const tournament = await prisma.tournament.findUnique({
    where: { tournamentId },
    select: {
      tournamentId: true,
      status: true,
      startTime: true
    }
  });

  if (!tournament || tournament.status !== 'upcoming') {
    return null;
  }

  if (tournament.startTime && new Date(tournament.startTime) > new Date()) {
    return null;
  }

  const updatedTournament = await prisma.tournament.update({
    where: { tournamentId },
    data: {
      status: 'active',
      stage: 'registration',
      startTime: tournament.startTime || new Date(),
      updatedAt: new Date()
    }
  });

  await publishEvent(
    Topics.TOURNAMENT_STARTED,
    {
      tournamentId: updatedTournament.tournamentId,
      name: updatedTournament.name,
      status: updatedTournament.status,
      stage: updatedTournament.stage,
      startTime: updatedTournament.startTime?.toISOString() || null
    },
    tournamentId
  ).catch((err) => {
    logger.error({ err }, 'Failed to publish tournament started event');
  });

  await ensureTournamentSchedule(tournamentId);

  logger.info({ tournamentId }, '[scheduler] Tournament started automatically');
  return updatedTournament;
}

async function completeSeason(seasonId) {
  const season = await prisma.season.findUnique({
    where: { seasonId },
    select: { seasonId: true, tournamentId: true, status: true, endTime: true, seasonNumber: true }
  });
  if (!season) return;
  if (season.status === 'completed' || season.status === 'finished') return;
  if (season.endTime && new Date(season.endTime) > new Date()) return;

  logger.info({ seasonId }, '[scheduler] Season completion is driven by match results; skipping timed completion');
}

async function startSchedulerWorker() {
  if (worker) return;

  worker = createWorker(QUEUE_NAME, async (job) => {
    if (job.name === 'ensure-next-season' || job.name === 'ensure-next-season-once') {
      const { tournamentId } = job.data;
      await ensureNextSeason(tournamentId);
      return;
    }
    if (job.name === 'start-tournament') {
      await startTournament(job.data.tournamentId);
      return;
    }
    if (job.name === 'close-season-joining') {
      await closeSeasonJoining(job.data.seasonId);
      return;
    }
    if (job.name === 'trigger-season-fixtures') {
      await triggerSeasonFixtures(job.data.seasonId);
      return;
    }
    if (job.name === 'complete-season') {
      await completeSeason(job.data.seasonId);
      return;
    }

    logger.warn({ jobName: job.name }, '[scheduler] Unknown job name');
  });

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id, jobName: job?.name }, '[scheduler] Job failed');
  });

  logger.info('[scheduler] Worker started');
}

module.exports = {
  ensureAiParticipant,
  normalizeGameType,
  startSchedulerWorker,
  ensureTournamentSchedule,
  ensureActiveTournamentSchedules,
  scheduleTournamentStart,
  cancelTournamentSchedule
};
