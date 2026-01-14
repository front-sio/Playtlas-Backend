const cron = require('node-cron');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { emitSeasonUpdate } = require('../utils/socketEmitter');
const { publishEvent, Topics } = require('../../../shared/events');
const { ensureAiParticipant, normalizeGameType } = require('./schedulerQueue');

const JOIN_WINDOW_MINUTES = Number(process.env.SEASON_JOIN_WINDOW_MINUTES || 30);
const FIXTURE_DELAY_MINUTES = Number(process.env.SEASON_FIXTURE_DELAY_MINUTES || 4);
const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.DEFAULT_MATCH_DURATION_SECONDS || 300);
const WITH_AI_SEASON_BUFFER = Number(process.env.WITH_AI_SEASON_BUFFER || 10);
const WITH_AI_INTERVAL_MINUTES = Number(process.env.WITH_AI_SEASON_INTERVAL_MINUTES || 1);

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
          name: true,
          metadata: true,
          entryFee: true
        }
      });

      for (const tournament of activeTournaments) {
        const gameType = normalizeGameType(tournament?.metadata?.gameType);
        const existingUpcomingCount = await prisma.season.count({
          where: {
            tournamentId: tournament.tournamentId,
            status: 'upcoming',
            startTime: { gt: now }
          }
        });
        if (gameType !== 'with_ai' && existingUpcomingCount > 0) {
          continue;
        }
        if (gameType === 'with_ai' && existingUpcomingCount >= WITH_AI_SEASON_BUFFER) {
          continue;
        }

        const lastSeason = await prisma.season.findFirst({
          where: { tournamentId: tournament.tournamentId },
          orderBy: { seasonNumber: 'desc' },
          select: { seasonNumber: true, endTime: true, status: true }
        });

        // Only generate a new season after the previous one finished.
        if (gameType !== 'with_ai' && lastSeason && now <= new Date(lastSeason.endTime)) {
          continue;
        }

        const nextSeasonNumber = lastSeason ? lastSeason.seasonNumber + 1 : 1;
        const matchDurationSeconds = Number(tournament.matchDuration || DEFAULT_MATCH_DURATION_SECONDS);
        const minStartTime = new Date(
          now.getTime() + (JOIN_WINDOW_MINUTES + FIXTURE_DELAY_MINUTES) * 60 * 1000
        );

        const createSeason = async (seasonNumber, startTime) => {
          const endTime = new Date(startTime.getTime() + matchDurationSeconds * 1000);
          const newSeason = await prisma.season.create({
            data: {
              tournamentId: tournament.tournamentId,
              seasonNumber,
              name: formatSeasonName(tournament.name, startTime),
              status: 'upcoming',
              joiningClosed: false,
              matchesGenerated: false,
              startTime,
              endTime
            }
          });

          await ensureAiParticipant({ tournament, season: newSeason }).catch((err) => {
            logger.error({ err, seasonId: newSeason.seasonId }, '[seasonGenerator] Failed to register AI');
          });

          logger.info(
            { seasonId: newSeason.seasonId, tournamentId: tournament.tournamentId },
            '[seasonGenerator] Created new season'
          );

          try {
            await publishEvent(Topics.SEASON_CREATED, {
              tournamentId: tournament.tournamentId,
              seasonId: newSeason.seasonId,
              seasonNumber,
              name: newSeason.name,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
              joinDeadline: new Date(now.getTime() + JOIN_WINDOW_MINUTES * 60 * 1000).toISOString()
            });
          } catch (eventError) {
            logger.error({ err: eventError, seasonId: newSeason.seasonId }, 'Failed to publish SEASON_CREATED event');
          }

          await emitSeasonUpdate({
            tournamentId: tournament.tournamentId,
            seasonId: newSeason.seasonId,
            event: 'season_created'
          });
        };

        if (gameType === 'with_ai') {
          const lastByStart = await prisma.season.findFirst({
            where: { tournamentId: tournament.tournamentId },
            orderBy: { startTime: 'desc' },
            select: { startTime: true }
          });
          const intervalMs = WITH_AI_INTERVAL_MINUTES * 60 * 1000;
          let startTime = minStartTime;
          if (lastByStart?.startTime) {
            const lastStartTime = new Date(lastByStart.startTime);
            if (lastStartTime >= minStartTime) {
              startTime = new Date(lastStartTime.getTime() + intervalMs);
            }
          }
          const seasonsToCreate = Math.max(0, WITH_AI_SEASON_BUFFER - existingUpcomingCount);
          for (let i = 0; i < seasonsToCreate; i += 1) {
            const scheduledStart = new Date(startTime.getTime() + i * intervalMs);
            await createSeason(nextSeasonNumber + i, scheduledStart);
          }
        } else {
          await createSeason(nextSeasonNumber, minStartTime);
        }
      }
    } catch (error) {
      logger.error('Error in season generator job:', error);
    }
  });
};

module.exports = { startSeasonGenerator };
