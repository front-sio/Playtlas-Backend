const cron = require('node-cron');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { publishEvent, Topics } = require('../../../../shared/events');
const { emitSeasonUpdate } = require('../utils/socketEmitter');
// AI logic removed

const FIXTURE_DELAY_MINUTES = Number(process.env.SEASON_FIXTURE_DELAY_MINUTES || 4);
const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.DEFAULT_MATCH_DURATION_SECONDS || 300);
const AI_PLAYER_ID = process.env.AI_PLAYER_ID || null;

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
          clubId: true,
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
          const tournament = await prisma.tournament.findUnique({
            where: { tournamentId: season.tournamentId },
            select: { tournamentId: true, clubId: true, status: true, stage: true, matchDuration: true, metadata: true, entryFee: true }
          });
          if (!tournament || !['active', 'stopped'].includes(tournament.status)) {
            continue;
          }

          const players = await prisma.tournamentPlayer.findMany({
            where: { seasonId: season.seasonId, status: { not: 'eliminated' } },
            select: { playerId: true }
          });
          const activePlayers = players.map((p) => p.playerId);
          const tournamentStage =
            tournament.stage && tournament.stage !== 'registration'
              ? tournament.stage
              : (activePlayers.length < 10 ? 'final' : 'group');
          const matchDurationSeconds = Number(tournament.matchDuration || DEFAULT_MATCH_DURATION_SECONDS);
          const seasonStartTime = season.startTime ? season.startTime.toISOString() : undefined;
          const gameType = tournament?.metadata?.gameType || 'multiplayer';
          const aiSettings = gameType === 'with_ai' ? computeAiSettings(tournament?.entryFee) : null;
          const aiDifficulty = tournament?.metadata?.aiDifficulty ?? aiSettings?.aiDifficulty ?? null;
          const level = tournament?.metadata?.level ?? aiSettings?.level ?? null;
          const aiRating = tournament?.metadata?.aiRating ?? aiSettings?.aiRating ?? null;
          const aiPlayerId = gameType === 'with_ai' ? AI_PLAYER_ID : null;

          if (activePlayers.length < 2) {
            const nowTime = new Date();
            await prisma.season.update({
              where: { seasonId: season.seasonId },
              data: {
                status: 'cancelled',
                matchesGenerated: true,
                joiningClosed: true,
                endTime: nowTime
              }
            });
            logger.info(
              { seasonId: season.seasonId, tournamentId: season.tournamentId, playerCount: activePlayers.length },
              '[fixtureGenerator] Season cancelled due to insufficient players'
            );
            await emitSeasonUpdate({
              tournamentId: season.tournamentId,
              seasonId: season.seasonId,
              event: 'season_cancelled'
            });
            await publishEvent(Topics.GENERATE_MATCHES, {
              tournamentId: season.tournamentId,
              seasonId: season.seasonId,
              clubId: season.clubId || tournament?.clubId || null,
              stage: tournamentStage,
              players: activePlayers,
              matchDurationSeconds,
              startTime: seasonStartTime,
              gameType,
              aiDifficulty,
              aiRating,
              level,
              aiPlayerId
            }).catch((eventErr) => {
              logger.error(
                { err: eventErr, seasonId: season.seasonId },
                '[fixtureGenerator] Failed to publish GENERATE_MATCHES for refund'
              );
            });
            continue;
          }

          // Mark season pending while fixtures are generated.
          await prisma.season.update({
            where: { seasonId: season.seasonId },
            data: { status: 'pending', matchesGenerated: false, errorReason: null }
          });

          try {
            await publishEvent(Topics.GENERATE_MATCHES, {
              tournamentId: season.tournamentId,
              seasonId: season.seasonId,
              clubId: season.clubId || tournament?.clubId || null,
              stage: tournamentStage,
              players: activePlayers,
              matchDurationSeconds,
              entryFee: Number(tournament?.entryFee || 0),
              startTime: seasonStartTime,
              gameType,
              aiDifficulty,
              aiRating,
              level,
              aiPlayerId
            });
            logger.info(
              { seasonId: season.seasonId, tournamentId: season.tournamentId },
              '[fixtureGenerator] Published GENERATE_MATCHES event (season pending activation)'
            );
          } catch (eventErr) {
            logger.error(
              { err: eventErr, seasonId: season.seasonId },
              '[fixtureGenerator] Failed to publish GENERATE_MATCHES event'
            );
            await prisma.season.update({
              where: { seasonId: season.seasonId },
              data: {
                status: 'error',
                errorReason: eventErr?.message || 'Failed to publish GENERATE_MATCHES'
              }
            });
          }
        }
      }
    } catch (error) {
      logger.error('Error in fixture generator job:', error);
    }
  });
};

module.exports = { startFixtureGenerator };
