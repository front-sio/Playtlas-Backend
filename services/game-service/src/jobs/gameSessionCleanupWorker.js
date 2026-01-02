const { createWorkerWithDlq } = require('../../../../shared/config/redis');
const { QueueNames } = require('../../../../shared/constants/queueNames');
const logger = require('../utils/logger');

function startGameSessionCleanupWorker() {
  const deadLetterQueueName = QueueNames.GAME_SESSION_CLEANUP + '-dlq';
  const concurrency = Number(process.env.GAME_SESSION_CLEANUP_CONCURRENCY || 5);

  const worker = createWorkerWithDlq(
    QueueNames.GAME_SESSION_CLEANUP,
    async (job) => {
      const { sessionId } = job.data || {};
      logger.info({ jobId: job.id, sessionId }, '[game-session-cleanup] Cleaning up game session');
      // Implement actual cleanup logic here (expire sessions, free tables, etc.)
    },
    { concurrency, deadLetterQueueName }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job && job.id, err }, '[game-session-cleanup] Job failed');
  });

  return worker;
}

module.exports = {
  startGameSessionCleanupWorker
};