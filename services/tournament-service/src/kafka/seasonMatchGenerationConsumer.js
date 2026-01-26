const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, Topics } = require('../../../../shared/events');
const { emitSeasonUpdate } = require('../utils/socketEmitter');

async function handleMatchesGenerated(payload) {
  const { tournamentId, seasonId, matchesCreated, scheduledCount } = payload || {};
  if (!tournamentId || !seasonId) return;

  const updated = await prisma.season.updateMany({
    where: {
      seasonId,
      tournamentId,
      status: { in: ['pending', 'upcoming', 'active'] }
    },
    data: {
      status: 'active',
      matchesGenerated: true,
      errorReason: null
    }
  });

  logger.info(
    { tournamentId, seasonId, matchesCreated, scheduledCount, updated: updated.count },
    '[seasonMatches] Season activated after match generation'
  );

  await emitSeasonUpdate({
    tournamentId,
    seasonId,
    event: 'season_matches_generated'
  });
}

async function handleMatchesFailed(payload) {
  const { tournamentId, seasonId, error } = payload || {};
  if (!tournamentId || !seasonId) return;

  await prisma.season.updateMany({
    where: { seasonId, tournamentId },
    data: {
      status: 'error',
      matchesGenerated: false,
      errorReason: error || 'Match generation failed'
    }
  });

  logger.error(
    { tournamentId, seasonId, error },
    '[seasonMatches] Season moved to error after match generation failure'
  );

  await emitSeasonUpdate({
    tournamentId,
    seasonId,
    event: 'season_matches_failed'
  });
}

async function startSeasonMatchGenerationConsumer() {
  await subscribeEvents(
    'tournament-service-season-matches',
    [Topics.SEASON_MATCHES_GENERATED, Topics.SEASON_MATCHES_FAILED],
    async (topic, payload) => {
      if (topic === Topics.SEASON_MATCHES_GENERATED) {
        await handleMatchesGenerated(payload);
        return;
      }
      if (topic === Topics.SEASON_MATCHES_FAILED) {
        await handleMatchesFailed(payload);
      }
    }
  );
}

module.exports = { startSeasonMatchGenerationConsumer };
