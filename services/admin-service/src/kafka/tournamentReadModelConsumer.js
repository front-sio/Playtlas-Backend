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
  return {
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
    seasonDuration: payload.seasonDuration !== undefined ? Number(payload.seasonDuration) : undefined,
    createdAt: toDate(payload.createdAt),
    updatedAt: toDate(payload.updatedAt) || new Date(),
    lastEventAt: new Date(),
    isDeleted
  };
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
