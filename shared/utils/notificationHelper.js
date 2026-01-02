// Shared notification helper built on BullMQ queues.
// This does not send emails/SMS directly; instead, it adds jobs to
// a shared notification queue that the notification-service processes.

const { createQueue, defaultJobOptions } = require('../config/redis');
const { logger } = require('./logger');
const { QueueNames } = require('../constants/queueNames');

const NOTIFICATION_DEFAULT_QUEUE_NAME = 'notification:send';

// Lazily created queue instances by name.
const queues = new Map();

function getQueue(name) {
  const key = name || NOTIFICATION_DEFAULT_QUEUE_NAME;
  if (!queues.has(key)) {
    queues.set(key, createQueue(key));
  }
  return queues.get(key);
}

/**
 * Enqueue a notification to be processed asynchronously.
 *
 * Payload example:
 * {
 *   userId: 'uuid',
 *   channel: 'email' | 'sms' | 'in_app',
 *   type: 'welcome' | 'prize' | 'tournament_update',
 *   title: 'Welcome to the platform',
 *   message: '...',
 *   data: { ... }
 * }
 *
 * Options:
 *   - queueName: override target queue (e.g. QueueNames.NOTIFICATIONS_HIGH_THROUGHPUT)
 *   - jobName: BullMQ job name (default 'send-notification')
 *   - plus any BullMQ JobOptions overrides.
 */
async function enqueueNotification(payload, opts = {}) {
  let {
    queueName,
    jobName = 'send-notification',
    ...jobOptions
  } = opts;

  // Auto-select queue based on channel if not explicitly provided
  if (!queueName && payload.channel) {
    switch (payload.channel) {
      case 'email':
        queueName = QueueNames.NOTIFICATIONS_EMAIL;
        break;
      case 'sms':
        queueName = QueueNames.NOTIFICATIONS_SMS;
        break;
      default:
        queueName = QueueNames.NOTIFICATIONS_IN_APP;
    }
  }

  // Fallback to default if still not set
  queueName = queueName || QueueNames.NOTIFICATIONS_IN_APP;

  const queue = getQueue(queueName);
  const jobOpts = { ...defaultJobOptions, ...jobOptions };

  const job = await queue.add(jobName, payload, jobOpts);
  logger.info({ jobId: job.id, userId: payload.userId, queueName }, '[notificationHelper] Notification job enqueued');
  return job;
}

module.exports = {
  NOTIFICATION_DEFAULT_QUEUE_NAME,
  enqueueNotification,
  getQueue
};
