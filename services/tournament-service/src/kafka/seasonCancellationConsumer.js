const logger = require('../utils/logger');
const { prisma } = require('../config/db');
const { subscribeEvents, Topics } = require('../../../../shared/events');
const { emitSeasonUpdate } = require('../utils/socketEmitter');

async function handleSeasonCancelled(payload) {
  const { tournamentId, seasonId, reason } = payload || {};
  if (!tournamentId || !seasonId) return;

  const season = await prisma.season.findUnique({
    where: { seasonId },
    select: { seasonId: true, status: true, tournamentId: true }
  });
  if (!season) return;
  if (['cancelled', 'completed', 'finished'].includes(season.status)) return;

  await prisma.season.update({
    where: { seasonId },
    data: {
      status: 'cancelled',
      endTime: new Date(),
      joiningClosed: true,
      matchesGenerated: true
    }
  });

  logger.info({ seasonId, tournamentId, reason }, '[season-cancelled] Season cancelled via Kafka');

  await emitSeasonUpdate({
    tournamentId: season.tournamentId,
    seasonId,
    event: 'season_cancelled'
  });
}

async function startSeasonCancellationConsumer() {
  await subscribeEvents('tournament-service', [Topics.SEASON_CANCELLED], async (_topic, payload) => {
    try {
      await handleSeasonCancelled(payload);
    } catch (err) {
      logger.error({ err, payload }, '[season-cancelled] Failed to handle SEASON_CANCELLED event');
    }
  });
  logger.info('[season-cancelled] Consumer started');
}

module.exports = {
  startSeasonCancellationConsumer
};
