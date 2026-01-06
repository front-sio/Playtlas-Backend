const cron = require('node-cron');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { emitSeasonUpdate } = require('../utils/socketEmitter');

const JOIN_WINDOW_MINUTES = Number(process.env.SEASON_JOIN_WINDOW_MINUTES || 5);
const FIXTURE_DELAY_MINUTES = Number(process.env.SEASON_FIXTURE_DELAY_MINUTES || 1);
const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.DEFAULT_MATCH_DURATION_SECONDS || 300);

function pad(num) {
  return String(num).padStart(2, '0');
}

function formatSeasonName(tournamentName, startTime) {
  const dt = new Date(startTime);
  const stamp = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  return `${tournamentName} ${stamp}`;
}


const startSeasonGenerator = () => {
  // Run every hour
  cron.schedule('0 * * * *', async () => {
    logger.info('Running season generator job...');
    try {
      const now = new Date();
      const activeTournaments = await prisma.tournament.findMany({
        where: { status: 'active' },
        select: {
          tournamentId: true,
          matchDuration: true,
          name: true
        }
      });

      for (const tournament of activeTournaments) {
        // Don't create a new season if there's already one scheduled in the future.
        const existingUpcoming = await prisma.season.findFirst({
          where: {
            tournamentId: tournament.tournamentId,
            status: 'upcoming',
            startTime: { gt: now }
          },
          select: { seasonId: true }
        });
        if (existingUpcoming) {
          continue;
        }

        const lastSeason = await prisma.season.findFirst({
          where: { tournamentId: tournament.tournamentId },
          orderBy: { seasonNumber: 'desc' },
          select: { seasonNumber: true, endTime: true, status: true }
        });

        // Only generate a new season after the previous one finished.
        if (lastSeason && now <= new Date(lastSeason.endTime)) {
          continue;
        }

        const nextSeasonNumber = lastSeason ? lastSeason.seasonNumber + 1 : 1;

        // Joining stays open for JOIN_WINDOW_MINUTES. Then we wait FIXTURE_DELAY_MINUTES
        // and trigger fixture generation. We use startTime as the "fixture generation time".
        const startTime = new Date(
          now.getTime() + (JOIN_WINDOW_MINUTES + FIXTURE_DELAY_MINUTES) * 60 * 1000
        );
        const matchDurationSeconds = Number(tournament.matchDuration || DEFAULT_MATCH_DURATION_SECONDS);
        const endTime = new Date(startTime.getTime() + matchDurationSeconds * 1000);

        const newSeason = await prisma.season.create({
          data: {
            tournamentId: tournament.tournamentId,
            seasonNumber: nextSeasonNumber,
            name: formatSeasonName(tournament.name, startTime),
            status: 'upcoming',
            joiningClosed: false,
            matchesGenerated: false,
            startTime,
            endTime
          }
        });

        logger.info(
          { seasonId: newSeason.seasonId, tournamentId: tournament.tournamentId },
          '[seasonGenerator] Created new season'
        );

        await emitSeasonUpdate({
          tournamentId: tournament.tournamentId,
          seasonId: newSeason.seasonId,
          event: 'season_created'
        });
      }
    } catch (error) {
      logger.error('Error in season generator job:', error);
    }
  });
};

module.exports = { startSeasonGenerator };
