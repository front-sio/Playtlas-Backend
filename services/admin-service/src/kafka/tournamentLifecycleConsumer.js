const logger = require('../utils/logger');
const { prisma } = require('../config/db');
const { subscribeEvents, Topics } = require('../../../../shared/events');

async function handleLifecycleEvent(topic, payload) {
  const { commandId, tournamentId } = payload || {};
  if (!commandId || !tournamentId) {
    return;
  }

  try {
    await prisma.approvalRequest.updateMany({
      where: { commandId },
      data: {
        resourceType: 'tournament',
        resourceId: tournamentId
      }
    });

    logger.info({ topic, commandId, tournamentId }, '[admin] Tournament lifecycle linked to approval');
  } catch (err) {
    logger.error({ err, topic, commandId, tournamentId }, '[admin] Failed to link lifecycle event to approval');
  }
}

async function startTournamentLifecycleConsumer() {
  await subscribeEvents(
    'admin-service',
    [
      Topics.TOURNAMENT_CREATED,
      Topics.TOURNAMENT_STARTED,
      Topics.TOURNAMENT_RESUMED,
      Topics.TOURNAMENT_STOPPED,
      Topics.TOURNAMENT_CANCELLED
    ],
    handleLifecycleEvent
  );

  logger.info('[admin] Tournament lifecycle consumer started');
}

module.exports = {
  startTournamentLifecycleConsumer
};
