const cron = require('node-cron');
const logger = require('../utils/logger');
const { createMatches } = require('../controllers/matchCreationController'); // Reusing match creation logic

module.exports = (tournamentPrisma) => {
  const job = cron.schedule('* * * * *', async () => { // Runs every minute
    logger.info('Running match generation job...');
  try {
    // Find active tournaments with active seasons where joining is closed and matches haven't been generated
    const seasonsReadyForMatching = await tournamentPrisma.season.findMany({
      where: {
        status: 'active',
        joiningClosed: true,
        matchesGenerated: false,
        tournament: {
          status: 'active',
        },
      },
      include: {
        tournament: true,
        tournamentPlayers: true, // Fetch players directly linked to this season
      },
    });

    for (const season of seasonsReadyForMatching) {
      const playersInSeason = season.tournamentPlayers.map(p => p.playerId);

      if (playersInSeason.length < 2) {
        logger.warn(`Season ${season.seasonId} for Tournament ${season.tournamentId} has less than 2 players. Skipping match generation.`);
        // Optionally, update season status to 'cancelled' or similar if not enough players
        continue;
      }

      logger.info(`Generating matches for Season ${season.seasonId} of Tournament ${season.tournamentId} with ${playersInSeason.length} players.`);

      // Generate matches using the existing createMatches logic
      // Pass relevant tournament/season details to createMatches
      await createMatches(playersInSeason, 'tournament', {
        tournamentId: season.tournamentId,
        seasonId: season.seasonId,
        stage: season.tournament.stage, // Use tournament's current stage
        roundNumber: 1, // Or determine based on season progress
      });

      // Mark season as matches generated to prevent re-processing
      await tournamentPrisma.season.update({
        where: { seasonId: season.seasonId },
        data: { matchesGenerated: true },
      });

      logger.info(`Matches generated and season ${season.seasonId} marked as processed.`);
    }

    logger.info('Match generation job completed.');
  } catch (error) {
    logger.error('Error running match generation job:', error);
  }
});
  return job;
};
