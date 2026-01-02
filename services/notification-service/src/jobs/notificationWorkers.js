const { createWorkerWithDlq } = require('../../../../shared/config/redis');
const { QueueNames } = require('../../../../shared/constants/queueNames');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');
const logger = require('../utils/logger');

function startNotificationWorkers() {
  const deadLetterSuffix = '-dlq';

  // Email notifications
  const emailWorker = createWorkerWithDlq(
    QueueNames.NOTIFICATIONS_EMAIL,
    async (job) => {
      const { userId, title, message, data, email } = job.data || {};
      const to = email || data?.email || 'user@example.com';
      await emailService.send(to, title, message, message);
      logger.info({ jobId: job.id, userId, to, action: 'email_sent' }, '[notification-workers] Email sent successfully');
    },
    { concurrency: Number(process.env.NOTIFICATIONS_EMAIL_CONCURRENCY || 5), deadLetterQueueName: QueueNames.NOTIFICATIONS_EMAIL + deadLetterSuffix }
  );

  // SMS notifications
  const smsWorker = createWorkerWithDlq(
    QueueNames.NOTIFICATIONS_SMS,
    async (job) => {
      const { userId, message, phone } = job.data || {};
      const to = phone || '+255712345678';
      await smsService.send(to, message);
      logger.info({ jobId: job.id, userId, to }, '[notification-workers] SMS sent');
    },
    { concurrency: Number(process.env.NOTIFICATIONS_SMS_CONCURRENCY || 10), deadLetterQueueName: QueueNames.NOTIFICATIONS_SMS + deadLetterSuffix }
  );

  // In-app + generic notifications (high-throughput)
  const inAppWorker = createWorkerWithDlq(
    QueueNames.NOTIFICATIONS_IN_APP,
    async (job) => {
      logger.info({ jobId: job.id, data: job.data }, '[notification-workers] In-app notification processed');
    },
    { concurrency: Number(process.env.NOTIFICATIONS_IN_APP_CONCURRENCY || 20), deadLetterQueueName: QueueNames.NOTIFICATIONS_IN_APP + deadLetterSuffix }
  );

  const bulkWorker = createWorkerWithDlq(
    QueueNames.NOTIFICATIONS_HIGH_THROUGHPUT,
    async (job) => {
      logger.info({ jobId: job.id, data: job.data }, '[notification-workers] High-throughput notification processed');
    },
    { concurrency: Number(process.env.NOTIFICATIONS_BULK_CONCURRENCY || 50), deadLetterQueueName: QueueNames.NOTIFICATIONS_HIGH_THROUGHPUT + deadLetterSuffix }
  );

  emailWorker.on('failed', (job, err) => logger.error({ jobId: job && job.id, err }, '[notification-workers] Email job failed'));
  smsWorker.on('failed', (job, err) => logger.error({ jobId: job && job.id, err }, '[notification-workers] SMS job failed'));
  inAppWorker.on('failed', (job, err) => logger.error({ jobId: job && job.id, err }, '[notification-workers] In-app job failed'));
  bulkWorker.on('failed', (job, err) => logger.error({ jobId: job && job.id, err }, '[notification-workers] Bulk job failed'));

  return { emailWorker, smsWorker, inAppWorker, bulkWorker };
}

module.exports = {
  startNotificationWorkers
};