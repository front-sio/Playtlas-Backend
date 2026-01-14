const logger = require('../utils/logger');
const { prisma } = require('../config/db');
const { subscribeEvents, Topics } = require('../../../../shared/events');

function toDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function buildUpdateData(payload, topic) {
  const isDeleted = topic === Topics.TOURNAMENT_DELETED || payload.status === 'deleted';
  
  // Build update data with only valid fields
  const updateData = {
    name: payload.name,
    description: payload.description ?? null,
    entryFee: payload.entryFee !== undefined ? Number(payload.entryFee) : undefined,
    maxPlayers: payload.maxPlayers !== undefined ? Number(payload.maxPlayers) : undefined,
    currentPlayers: payload.currentPlayers !== undefined ? Number(payload.currentPlayers) : undefined,
    status: payload.status,
    stage: payload.stage ?? null,
    competitionWalletId: payload.competitionWalletId ?? null,
    startTime: toDate(payload.startTime),
    endTime: toDate(payload.endTime),
    createdAt: toDate(payload.createdAt),
    updatedAt: toDate(payload.updatedAt) || new Date(),
    lastEventAt: new Date(),
    isDeleted
  };
  
  // Only add optional fields if they exist to avoid schema errors
  if (payload.matchDuration !== undefined) {
    updateData.matchDuration = Number(payload.matchDuration);
  }
  if (payload.seasonDuration !== undefined) {
    updateData.seasonDuration = Number(payload.seasonDuration);
  }
  
  // Remove undefined values to avoid Prisma validation errors
  Object.keys(updateData).forEach(key => {
    if (updateData[key] === undefined) {
      delete updateData[key];
    }
  });
  
  return updateData;
}

async function handleTournamentSnapshot(topic, payload) {
  if (!payload?.tournamentId) return;

  const updateData = buildUpdateData(payload, topic);
  const createData = {
    tournamentId: payload.tournamentId,
    ...updateData,
    createdAt: updateData.createdAt || new Date()
  };

  await prisma.tournamentReadModel.upsert({
    where: { tournamentId: payload.tournamentId },
    update: updateData,
    create: createData
  });

  logger.info({ topic, tournamentId: payload.tournamentId }, '[admin] Tournament read model updated');
}

async function startTournamentReadModelConsumer() {
  await subscribeEvents(
    'admin-service',
    [
      Topics.TOURNAMENT_CREATED,
      Topics.TOURNAMENT_STARTED,
      Topics.TOURNAMENT_STOPPED,
      Topics.TOURNAMENT_CANCELLED,
      Topics.TOURNAMENT_UPDATED,
      Topics.TOURNAMENT_DELETED
    ],
    handleTournamentSnapshot
  );

  logger.info('[admin] Tournament read model consumer started');
}

module.exports = {
  startTournamentReadModelConsumer
};
