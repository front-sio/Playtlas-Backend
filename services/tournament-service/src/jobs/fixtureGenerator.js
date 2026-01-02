const cron = require('node-cron');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { publishEvent, Topics } = require('../../../../shared/events');

const FIXTURE_DELAY_MINUTES = Number(process.env.SEASON_FIXTURE_DELAY_MINUTES || 4);

const startFixtureGenerator = () => {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    logger.info('Running fixture generator job...');
    try {
      const now = new Date();
      const upcomingSeasons = await prisma.season.findMany({
        where: { status: 'upcoming' },
        select: {
          seasonId: true,
          tournamentId: true,
          startTime: true,
          joiningClosed: true,
          matchesGenerated: true
        }
      });

      for (const season of upcomingSeasons) {
        const fixtureTime = new Date(season.startTime);
        const joiningCloseTime = new Date(
          fixtureTime.getTime() - FIXTURE_DELAY_MINUTES * 60 * 1000
        );

        // Step 1: Close joining when the joining window ends.
        if (!season.joiningClosed && now >= joiningCloseTime) {
          await prisma.season.update({
            where: { seasonId: season.seasonId },
            data: { joiningClosed: true }
          });
          logger.info(
            { seasonId: season.seasonId, tournamentId: season.tournamentId },
            '[fixtureGenerator] Joining closed'
          );
        }

        // Step 2: Trigger match generation at fixture time (event-driven).
        if (!season.matchesGenerated && now >= fixtureTime) {
          // Only activate the season at fixture time.
          await prisma.season.update({
            where: { seasonId: season.seasonId },
            data: { status: 'active' }
          });

          try {
            await publishEvent(Topics.GENERATE_MATCHES, {
              tournamentId: season.tournamentId,
              seasonId: season.seasonId
            });
            logger.info(
              { seasonId: season.seasonId, tournamentId: season.tournamentId },
              '[fixtureGenerator] Published GENERATE_MATCHES event'
            );
          } catch (eventErr) {
            logger.error(
              { err: eventErr, seasonId: season.seasonId },
              '[fixtureGenerator] Failed to publish GENERATE_MATCHES event'
            );
          }
        }
      }
    } catch (error) {
      logger.error('Error in fixture generator job:', error);
    }
  });
};

module.exports = { startFixtureGenerator };
