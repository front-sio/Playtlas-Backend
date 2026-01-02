const { prisma } = require('../config/db');
const { createWorkerWithDlq } = require('../../../../shared/config/redis');
const { QueueNames } = require('../../../../shared/constants/queueNames');
const { completeMatchAndProgress } = require('../../../../shared/utils/tournamentHelper');
const { publishEvent, Topics } = require('../../../../shared/events');
const logger = require('../utils/logger');

function startTournamentProgressionWorker() {
  const deadLetterQueueName = QueueNames.TOURNAMENT_STAGE_PROGRESSION + '-dlq';
  const concurrency = Number(process.env.TOURNAMENT_STAGE_PROGRESS_CONCURRENCY || 5);

  const worker = createWorkerWithDlq(
    QueueNames.TOURNAMENT_STAGE_PROGRESSION,
    async (job) => {
      const { matchId, winnerId } = job.data || {};
      if (!matchId || !winnerId) {
        throw new Error('matchId and winnerId are required');
      }

      const result = await completeMatchAndProgress(db, { tournaments, tournamentPlayers, matches }, { matchId, winnerId });

      await publishEvent(Topics.MATCH_COMPLETED, {
        tournamentId: result.tournamentId,
        seasonId: result.seasonId,
        matchId: result.matchId,
        stage: result.stage,
        roundNumber: 1,
        winnerId: result.winnerId,
        loserId: result.loserId,
        isFinal: result.isFinal,
        winnerPrize: result.winnerPrize
      });

      logger.info({ matchId, winnerId }, '[tournament-progression-worker] Match processed');
    },
    { concurrency, deadLetterQueueName }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job && job.id, err }, '[tournament-progression-worker] Job failed');
  });

  return worker;
}

module.exports = {
  startTournamentProgressionWorker
};