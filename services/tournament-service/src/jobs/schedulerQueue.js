const logger = require('../utils/logger');
const { prisma } = require('../config/db');
const { createQueue, createWorker, defaultJobOptions } = require('../../../../shared/config/redis');
const { publishEvent, Topics } = require('../../../../shared/events');

const QUEUE_NAME = 'tournament-scheduler';

const JOIN_WINDOW_MINUTES = Number(process.env.SEASON_JOIN_WINDOW_MINUTES || 5);
const FIXTURE_DELAY_MINUTES = Number(process.env.SEASON_FIXTURE_DELAY_MINUTES || 1);
const SEASON_SCHEDULE_EVERY_MS = Number(process.env.SEASON_SCHEDULE_EVERY_MS || 5 * 60 * 1000);

let queue;
let worker;

function getQueue() {
  if (!queue) {
    queue = createQueue(QUEUE_NAME);
  }
  return queue;
}

function computeTimes(anchorTime, seasonDurationSeconds) {
  const fixtureTime = new Date(anchorTime);
  const joiningCloseAt = new Date(
    fixtureTime.getTime() - FIXTURE_DELAY_MINUTES * 60 * 1000
  );
  const endTime = new Date(fixtureTime.getTime() + seasonDurationSeconds * 1000);
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



async function ensureNextSeason(tournamentId) {
  const tournament = await prisma.tournament.findUnique({
    where: { tournamentId },
    select: {
      tournamentId: true,
      status: true,
      seasonDuration: true,
      stage: true,
      name: true
    }
  });
  if (!tournament || tournament.status !== 'active') {
    return null;
  }

  const now = new Date();
  const existingUpcoming = await prisma.season.findFirst({
    where: {
      tournamentId,
      status: 'upcoming',
      startTime: { gt: now }
    },
    select: { seasonId: true }
  });
  if (existingUpcoming) {
    return null;
  }

  const lastSeason = await prisma.season.findFirst({
    where: { tournamentId },
    orderBy: { seasonNumber: 'desc' },
    select: { seasonNumber: true, endTime: true, status: true }
  });

  const nextSeasonNumber = lastSeason ? lastSeason.seasonNumber + 1 : 1;
  const anchorTime = lastSeason?.endTime
    ? new Date(lastSeason.endTime)
    : new Date(now.getTime() + (JOIN_WINDOW_MINUTES + FIXTURE_DELAY_MINUTES) * 60 * 1000);
  const { fixtureTime, joiningCloseAt, endTime } = computeTimes(anchorTime, tournament.seasonDuration);

  const season = await prisma.season.create({
    data: {
      tournamentId,
      seasonNumber: nextSeasonNumber,
      name: formatSeasonName(tournament.name, fixtureTime),
      status: 'upcoming',
      joiningClosed: false,
      matchesGenerated: false,
      startTime: fixtureTime,
      endTime
    }
  });

  // Close joining and trigger fixtures using delayed jobs.
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
    { tournamentId, seasonId: season.seasonId, joiningCloseAt, fixtureTime },
    '[scheduler] Season created and jobs scheduled'
  );

  return season;
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
    select: { status: true }
  });
  if (!tournament || tournament.status !== 'active') {
    return;
  }

  await prisma.season.update({
    where: { seasonId },
    data: { joiningClosed: true }
  });
  logger.info({ seasonId }, '[scheduler] Season joining closed');
}

async function triggerSeasonFixtures(seasonId) {
  const season = await prisma.season.findUnique({
    where: { seasonId },
    include: {
      tournament: { select: { tournamentId: true, status: true, stage: true } },
      tournamentPlayers: { select: { playerId: true, status: true } }
    }
  });
  if (!season) return;
  if (season.matchesGenerated) return;
  if (season.status !== 'upcoming') return;
  if (!season.tournament || season.tournament.status !== 'active') return;

  const activePlayers = season.tournamentPlayers
    .filter((p) => p.status !== 'eliminated')
    .map((p) => p.playerId);

  if (activePlayers.length < 2) {
    await prisma.season.update({
      where: { seasonId },
      data: { status: 'finished', matchesGenerated: true }
    });
    logger.info({ seasonId }, '[scheduler] Season finished due to insufficient players');
    await publishEvent(
      Topics.SEASON_COMPLETED,
      {
        tournamentId: season.tournament.tournamentId,
        seasonId,
        status: 'finished',
        endedAt: new Date().toISOString()
      },
      seasonId
    );
    return;
  }

  // Activate season at fixture time.
  await prisma.season.update({
    where: { seasonId },
    data: { status: 'active', matchesGenerated: true }
  });

  const tournamentStage =
    season.tournament.stage && season.tournament.stage !== 'registration'
      ? season.tournament.stage
      : 'group';

  await publishEvent(
    Topics.GENERATE_MATCHES,
    {
      tournamentId: season.tournament.tournamentId,
      seasonId: season.seasonId,
      stage: tournamentStage,
      players: activePlayers
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
  await q.add(
    'ensure-next-season',
    { tournamentId },
    {
      ...defaultJobOptions,
      jobId: `tournament:${tournamentId}:ensure-next-season`,
      repeat: { every: SEASON_SCHEDULE_EVERY_MS }
    }
  );

  // Also run once immediately to seed first season.
  await q.add(
    'ensure-next-season-once',
    { tournamentId },
    {
      ...defaultJobOptions,
      jobId: `tournament:${tournamentId}:ensure-next-season-once`
    }
  );
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

  await prisma.season.update({
    where: { seasonId },
    data: { status: 'completed' }
  });

  await publishEvent(
    Topics.SEASON_COMPLETED,
    {
      tournamentId: season.tournamentId,
      seasonId: season.seasonId,
      status: 'completed',
      endedAt: new Date().toISOString()
    },
    season.seasonId
  );

  logger.info({ seasonId }, '[scheduler] Season completed');
  await ensureNextSeason(season.tournamentId);
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
  startSchedulerWorker,
  ensureTournamentSchedule,
  scheduleTournamentStart,
  cancelTournamentSchedule
};
