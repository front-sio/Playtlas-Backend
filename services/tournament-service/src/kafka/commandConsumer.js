const logger = require('../utils/logger');
const { prisma } = require('../config/db');
const { subscribeEvents, publishEvent, Topics } = require('../../../../shared/events');
const { ensureTournamentSchedule, startSchedulerWorker, scheduleTournamentStart, cancelTournamentSchedule } = require('../jobs/schedulerQueue');

const DEFAULT_SEASON_DURATION = 20 * 60;
function buildTournamentMetadata(existing, actor) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  if (actor) {
    base.createdBy = base.createdBy || actor.userId;
    base.role = base.role || actor.role;
  }
  return base;
}

function buildTournamentSnapshot(tournament, extra = {}) {
  return {
    tournamentId: tournament.tournamentId,
    name: tournament.name,
    description: tournament.description || null,
    entryFee: Number(tournament.entryFee),
    maxPlayers: tournament.maxPlayers,
    currentPlayers: tournament.currentPlayers,
    status: tournament.status,
    stage: tournament.stage,
    competitionWalletId: tournament.competitionWalletId || null,
    startTime: tournament.startTime ? tournament.startTime.toISOString() : null,
    endTime: tournament.endTime ? tournament.endTime.toISOString() : null,
    seasonDuration: tournament.seasonDuration,
    createdAt: tournament.createdAt ? tournament.createdAt.toISOString() : null,
    updatedAt: tournament.updatedAt ? tournament.updatedAt.toISOString() : null,
    ...extra
  };
}

async function hasProcessed(commandId) {
  const existing = await prisma.tournamentCommandLog.findUnique({
    where: { commandId }
  });
  return !!existing;
}

async function markCommand(commandId, action, status, tournamentId, error) {
  await prisma.tournamentCommandLog.create({
    data: {
      commandId,
      action,
      status,
      tournamentId: tournamentId || null,
      error: error || null
    }
  });
}

async function publishCommandResult(commandId, action, status, data, error) {
  try {
    await publishEvent(
      Topics.TOURNAMENT_COMMAND_RESULT,
      {
        commandId,
        action,
        status,
        data: data ?? null,
        error: error || null
      },
      commandId
    );
  } catch (err) {
    logger.error({ err, commandId, action }, '[tournament-command] Failed to publish command result');
  }
}

async function handleCreate(commandId, data, actor) {
  const { name, description, entryFee, maxPlayers, seasonDuration, startTime } = data;
  if (!name || entryFee === undefined) {
    throw new Error('name and entryFee are required');
  }

  const parsedStartTime = startTime ? new Date(startTime) : new Date(Date.now() + 3600000);

  const tournament = await prisma.tournament.create({
    data: {
      name,
      description: description || null,
      entryFee,
      maxPlayers: maxPlayers || undefined,
      seasonDuration: seasonDuration || DEFAULT_SEASON_DURATION,
      competitionWalletId: null,
      startTime: parsedStartTime,
      status: 'upcoming',
      stage: 'registration',
      metadata: buildTournamentMetadata(undefined, actor)
    }
  });

  await scheduleTournamentStart(tournament.tournamentId, tournament.startTime);

  await publishEvent(
    Topics.TOURNAMENT_CREATED,
    buildTournamentSnapshot(tournament, { commandId }),
    commandId
  );
  return tournament;
}

async function handleStart(commandId, data, actor) {
  const { tournamentId } = data;
  if (!tournamentId) throw new Error('tournamentId is required');

  const existing = await prisma.tournament.findUnique({
    where: { tournamentId },
    select: { metadata: true }
  });

  const tournament = await prisma.tournament.update({
    where: { tournamentId },
    data: {
      status: 'active',
      startTime: new Date(),
      updatedAt: new Date(),
      metadata: actor
        ? {
            ...buildTournamentMetadata(existing?.metadata, null),
            lastStartedBy: actor.userId,
            lastStartedRole: actor.role
          }
        : buildTournamentMetadata(existing?.metadata, null)
    }
  });

  await publishEvent(
    Topics.TOURNAMENT_STARTED,
    buildTournamentSnapshot(tournament, { commandId }),
    commandId
  );

  // Ensure scheduler worker is running and schedule seasons for this tournament.
  await startSchedulerWorker();
  await ensureTournamentSchedule(tournamentId);

  return tournament;
}

async function handleStop(commandId, data) {
  const { tournamentId, reason } = data;
  if (!tournamentId) throw new Error('tournamentId is required');

  const existing = await prisma.tournament.findUnique({
    where: { tournamentId },
    select: { metadata: true }
  });

  const tournament = await prisma.tournament.update({
    where: { tournamentId },
    data: {
      status: 'stopped',
      endTime: new Date(),
      metadata: {
        ...(existing?.metadata || {}),
        stopReason: reason || null
      }
    }
  });

  await cancelTournamentSchedule(tournamentId);

  await publishEvent(
    Topics.TOURNAMENT_STOPPED,
    buildTournamentSnapshot(tournament, { commandId, reason: reason || null }),
    commandId
  );
  return tournament;
}

async function handleCancel(commandId, data) {
  const { tournamentId, reason } = data;
  if (!tournamentId) throw new Error('tournamentId is required');

  const existing = await prisma.tournament.findUnique({
    where: { tournamentId },
    select: { metadata: true }
  });

  const tournament = await prisma.tournament.update({
    where: { tournamentId },
    data: {
      status: 'cancelled',
      endTime: new Date(),
      metadata: {
        ...(existing?.metadata || {}),
        cancelReason: reason || null
      }
    }
  });

  await cancelTournamentSchedule(tournamentId);

  await publishEvent(
    Topics.TOURNAMENT_CANCELLED,
    buildTournamentSnapshot(tournament, { commandId, reason: reason || null }),
    commandId
  );
  return tournament;
}

async function handleUpdate(commandId, data, actor) {
  const { tournamentId, ...updateData } = data || {};
  if (!tournamentId) throw new Error('tournamentId is required');

  const sanitized = { ...updateData };
  delete sanitized.createdAt;
  delete sanitized.tournamentId;
  delete sanitized.competitionWalletId;

  const updated = await prisma.tournament.update({
    where: { tournamentId },
    data: {
      ...sanitized,
      updatedAt: new Date(),
      metadata: actor ? { ...(typeof (actor || {}) === 'object' ? { lastUpdatedBy: actor.userId, lastUpdatedRole: actor.role } : {}) } : undefined
    }
  });

  if (sanitized.startTime && updated.status === 'upcoming') {
    await scheduleTournamentStart(updated.tournamentId, updated.startTime);
  }

  await publishEvent(
    Topics.TOURNAMENT_UPDATED,
    buildTournamentSnapshot(updated, { commandId }),
    commandId
  );

  return updated;
}

async function handleDelete(commandId, data) {
  const { tournamentId } = data || {};
  if (!tournamentId) throw new Error('tournamentId is required');

  const tournament = await prisma.tournament.findUnique({
    where: { tournamentId },
    include: {
      seasons: true,
      tournamentPlayers: true
    }
  });

  if (!tournament) {
    throw new Error('Tournament not found');
  }

  if (tournament.status === 'active') {
    throw new Error('Cannot delete active tournament. Cancel it first.');
  }

  await publishEvent(
    Topics.TOURNAMENT_DELETED,
    buildTournamentSnapshot(tournament, { status: 'deleted', deletedAt: new Date().toISOString(), commandId }),
    commandId
  );

  await prisma.$transaction(async (tx) => {
    await tx.seasonParticipant.deleteMany({
      where: {
        season: {
          tournamentId
        }
      }
    });

    await tx.fixture.deleteMany({
      where: {
        season: {
          tournamentId
        }
      }
    });

    await tx.season.deleteMany({
      where: { tournamentId }
    });

    await tx.tournamentPlayer.deleteMany({
      where: { tournamentId }
    });

    await tx.tournament.delete({
      where: { tournamentId }
    });
  });

  return { tournamentId };
}

async function handleGet(commandId, data) {
  const { tournamentId } = data || {};
  if (!tournamentId) throw new Error('tournamentId is required');

  const tournament = await prisma.tournament.findUnique({
    where: { tournamentId },
    include: { tournamentPlayers: true }
  });

  if (!tournament) {
    throw new Error('Tournament not found');
  }

  return tournament;
}

async function handleList(commandId, data) {
  const { status, limit = 50, offset = 0 } = data || {};
  const where = {};
  if (status && status !== 'all') {
    where.status = status;
  }

  const [items, total] = await Promise.all([
    prisma.tournament.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      skip: Number(offset)
    }),
    prisma.tournament.count({ where })
  ]);

  return { items, total };
}

async function handleStats() {
  const [totalTournaments, totalPlayers, activeSeasons] = await Promise.all([
    prisma.tournament.count(),
    prisma.tournamentPlayer.count(),
    prisma.season.count({ where: { status: 'active' } })
  ]);

  const byStatus = await prisma.tournament.groupBy({
    by: ['status'],
    _count: { _all: true }
  });

  const statusCounts = byStatus.reduce((acc, row) => {
    acc[row.status] = row._count._all;
    return acc;
  }, {});

  return {
    totalTournaments,
    totalPlayers,
    activeSeasons,
    statusCounts
  };
}

async function startTournamentCommandConsumer() {
  // Scheduler worker should be ready (safe to call multiple times).
  await startSchedulerWorker();

  await subscribeEvents('tournament-service', [Topics.TOURNAMENT_COMMAND], async (topic, payload) => {
    if (topic !== Topics.TOURNAMENT_COMMAND) return;

    const { commandId, action, data, actor } = payload || {};
    if (!commandId || !action) {
      logger.warn({ payload }, '[tournament-command] Missing commandId/action');
      return;
    }

    if (await hasProcessed(commandId)) {
      logger.info({ commandId }, '[tournament-command] Duplicate command ignored');
      return;
    }

    try {
      let tournament;
      if (action === 'CREATE') {
        tournament = await handleCreate(commandId, data, actor);
      } else if (action === 'START') {
        tournament = await handleStart(commandId, data, actor);
      } else if (action === 'STOP') {
        tournament = await handleStop(commandId, data);
      } else if (action === 'CANCEL') {
        tournament = await handleCancel(commandId, data);
      } else if (action === 'UPDATE') {
        tournament = await handleUpdate(commandId, data, actor);
      } else if (action === 'DELETE') {
        tournament = await handleDelete(commandId, data);
      } else if (action === 'GET') {
        tournament = await handleGet(commandId, data);
      } else if (action === 'LIST') {
        tournament = await handleList(commandId, data);
      } else if (action === 'STATS') {
        tournament = await handleStats();
      } else {
        throw new Error(`Unsupported command action: ${action}`);
      }

      await markCommand(commandId, action, 'processed', tournament?.tournamentId);
      await publishCommandResult(commandId, action, 'success', tournament, null);
      logger.info({ commandId, action }, '[tournament-command] Processed');
    } catch (err) {
      await markCommand(commandId, action, 'failed', data?.tournamentId, err.message);
      await publishCommandResult(commandId, action, 'failed', null, err.message);
      logger.error({ err, commandId, action }, '[tournament-command] Failed');
    }
  });

  logger.info('[tournament-command] Consumer started');
}

module.exports = {
  startTournamentCommandConsumer
};
