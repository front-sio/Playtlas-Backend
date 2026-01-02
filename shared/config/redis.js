// Redis / BullMQ helpers for queues and caching.
//
// bullmq is treated as an optional dependency at the shared layer so that
// services can start even if it is not installed yet. However, any service
// that actually uses queues MUST have bullmq installed in its own
// package.json.

let Queue;
let Worker;
let QueueEvents;

try {
  // eslint-disable-next-line global-require
  ({ Queue, Worker, QueueEvents } = require('bullmq'));
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[shared/redis] bullmq is not installed; queue helpers will throw if used');
}

const { env } = require('./env');

function connectionFromUrl(redisUrl) {
  const parsed = new URL(redisUrl);
  const isTls = parsed.protocol === 'rediss:';
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  const port = parsed.port ? Number(parsed.port) : undefined;
  const host = parsed.hostname || undefined;
  const connection = {
    host,
    port,
    username,
    password
  };
  if (isTls) {
    connection.tls = {};
  }
  return connection;
}

/**
 * Shared Redis connection options for BullMQ.
 */
const redisConnection = env.REDIS_URL
  ? connectionFromUrl(env.REDIS_URL)
  : {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      username: env.REDIS_USERNAME,
      ...(env.REDIS_TLS ? { tls: {} } : {})
    };

/**
 * Create a BullMQ Queue.
 */
function createQueue(name) {
  if (!Queue) {
    throw new Error('[shared/redis] bullmq is not installed. Install it in this service to use queues.');
  }
  return new Queue(name, { connection: redisConnection });
}

/**
 * Create a BullMQ Worker.
 */
function createWorker(name, processor, opts) {
  if (!Worker) {
    throw new Error('[shared/redis] bullmq is not installed. Install it in this service to use workers.');
  }
  return new Worker(name, processor, {
    connection: redisConnection,
    concurrency: (opts && opts.concurrency) || 1
  });
}

/**
 * Create a BullMQ Worker with optional dead-letter queue support.
 *
 * opts: {
 *   concurrency?: number;
 *   deadLetterQueueName?: string;
 * }
 */
function createWorkerWithDlq(name, processor, opts = {}) {
  if (!Worker) {
    throw new Error('[shared/redis] bullmq is not installed. Install it in this service to use workers.');
  }

  const { deadLetterQueueName, concurrency } = opts;
  const worker = new Worker(name, processor, {
    connection: redisConnection,
    concurrency: concurrency || 1
  });

  if (deadLetterQueueName) {
    const dlq = new Queue(deadLetterQueueName, { connection: redisConnection });
    worker.on('failed', async (job, err) => {
      // When a job exhausts its retries, forward it to the DLQ for later inspection.
      if (job.attemptsMade >= (job.opts.attempts || 1)) {
        await dlq.add(job.name, {
          originalJobId: job.id,
          data: job.data,
          failedReason: err && err.message,
          attemptsMade: job.attemptsMade
        });
      }
    });
  }

  return worker;
}

/**
 * Create QueueEvents for listening to job lifecycle events.
 */
function createQueueEvents(name) {
  if (!QueueEvents) {
    throw new Error('[shared/redis] bullmq is not installed. Install it in this service to use queue events.');
  }
  return new QueueEvents(name, { connection: redisConnection });
}

/**
 * Default job options (retries, backoff, cleanup).
 */
const defaultJobOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1000
  },
  removeOnComplete: true,
  removeOnFail: false
};

module.exports = {
  redisConnection,
  createQueue,
  createWorker,
  createWorkerWithDlq,
  createQueueEvents,
  defaultJobOptions
};
