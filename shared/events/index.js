// Centralized Kafka events helper.
// Provides topic names and simple publish/subscribe wrappers using kafkajs.

const { createKafkaProducer, createKafkaConsumer } = require('../config/kafka');
const { logger } = require('../utils/logger');
const { validateEventPayload } = require('./schemas');

// Central topic constants used across services.
// NOTE: These are the canonical topic names for inter-service contracts.
const Topics = {
  PLAYER_REGISTERED: 'auth.player_registered',
  WALLET_CREATED: 'wallet.wallet_created',
  PLAYER_JOINED_SEASON: 'tournament.player_joined_season',
  SEASON_FEE_DEBITED: 'wallet.season_fee_debited',
  SEASON_COMPLETED: 'tournament.season_completed',
  GENERATE_MATCHES: 'tournament.generate_matches',
  MATCH_COMPLETED: 'tournament.match_completed',
  MATCH_RESULT: 'tournament.match_result',
  PRIZE_CREDITED: 'wallet.prize_credited',
  NOTIFICATION_SEND: 'notification.send',

  // Payment events
  DEPOSIT_APPROVED: 'payment.deposit_approved',
  WITHDRAWAL_APPROVED: 'payment.withdrawal_approved',
  FLOAT_ADJUSTMENT_REQUESTED: 'payment.float_adjustment_requested',
  FLOAT_ADJUSTMENT_APPROVED: 'payment.float_adjustment_approved',
  FLOAT_ADJUSTMENT_REJECTED: 'payment.float_adjustment_rejected',

  // Admin-driven tournament commands + lifecycle events
  TOURNAMENT_COMMAND: 'tournament.command',
  TOURNAMENT_COMMAND_RESULT: 'tournament.command_result',
  TOURNAMENT_CREATED: 'tournament.created',
  TOURNAMENT_STARTED: 'tournament.started',
  TOURNAMENT_STOPPED: 'tournament.stopped',
  TOURNAMENT_CANCELLED: 'tournament.cancelled',
  TOURNAMENT_UPDATED: 'tournament.updated',
  TOURNAMENT_DELETED: 'tournament.deleted'
};

let producerPromise = null;

async function getProducer() {
  if (!producerPromise) {
    const producer = createKafkaProducer();
    producerPromise = producer
      .connect()
      .then(() => {
        logger.info('[events] Kafka producer connected');
        return producer;
      })
      .catch((err) => {
        logger.error({ err }, '[events] Failed to connect Kafka producer');
        producerPromise = null;
        throw err;
      });
  }
  return producerPromise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Publish an event to Kafka.
 *
 * Backwards-compatible signature:
 *   publishEvent(topic, payload)
 *   publishEvent(topic, payload, key)
 *   publishEvent(topic, payload, key, options)
 *   publishEvent(topic, payload, options)
 *
 * options: {
 *   retries?: number; // default 3
 *   validate?: boolean; // default true
 * }
 */
async function publishEvent(topic, payload, keyOrOptions, maybeOptions) {
  let key;
  let options;

  if (typeof keyOrOptions === 'string' || typeof keyOrOptions === 'number') {
    key = String(keyOrOptions);
    options = maybeOptions || {};
  } else {
    options = keyOrOptions || {};
  }

  const { retries = 3, validate = true } = options;

  if (validate) {
    const { ok, error } = validateEventPayload(topic, payload);
    if (!ok) {
      logger.error({ topic, error, payload }, '[events] Event validation failed');
      throw new Error(`Invalid payload for topic ${topic}: ${error}`);
    }
  }

  const producer = await getProducer();
  const message = {
    value: JSON.stringify(payload)
  };
  if (key) message.key = String(key);

  let attempt = 0;
  // Simple retry with exponential backoff.
  // Kafka itself provides durability; this just smooths over transient client/network errors.
  // We use at-most-once semantics from the publisher perspective; idempotency must be
  // handled by consumers.
  //
  // NOTE: callers should choose an idempotent key when appropriate.
  //
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await producer.send({
        topic,
        messages: [message]
      });

      logger.debug({ topic, key, payload }, '[events] Event published');
      return;
    } catch (err) {
      attempt += 1;
      logger.error({ err, topic, key, attempt }, '[events] Failed to publish event');
      if (attempt > retries) {
        throw err;
      }
      const delay = Math.min(1000 * 2 ** (attempt - 1), 5000);
      await sleep(delay);
    }
  }
}

/**
 * Subscribe to one or more topics.
 *
 * @param {string} groupId - Kafka consumer group id.
 * @param {string[]} topics - Topic names.
 * @param {(topic: string, payload: any) => Promise<void>|void} handler
 */
async function subscribeEvents(groupId, topics, handler) {
  const consumer = createKafkaConsumer(groupId);

  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning: false });

  logger.info({ groupId, topics }, '[events] Kafka consumer subscribed');

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const key = message.key ? message.key.toString() : undefined;
      const rawValue = message.value ? message.value.toString() : '{}';

      let payload;
      try {
        payload = JSON.parse(rawValue);
      } catch (parseErr) {
        logger.error({ err: parseErr, topic, partition, key, rawValue }, '[events] Failed to parse Kafka message payload');
        return;
      }

      const { ok, value, error } = validateEventPayload(topic, payload);
      if (!ok) {
        logger.error({ topic, partition, key, error, payload }, '[events] Incoming event failed validation');
        return;
      }

      try {
        await handler(topic, value);
      } catch (err) {
        logger.error({ err, topic, partition, key }, '[events] Error handling Kafka message');
        // Basic retry is handled by Kafka consumer re-processing on failure scenarios.
      }
    }
  });
}

module.exports = {
  Topics,
  publishEvent,
  subscribeEvents
};
