// Kafka setup using kafkajs for event-driven microservices.
//
// kafkajs is treated as an optional dependency at the shared layer so that
// services can start even if it is not installed yet. However, any service
// that actually publishes/consumes events MUST have kafkajs installed in
// its own package.json.

let Kafka;

try {
  // eslint-disable-next-line global-require
  ({ Kafka } = require('kafkajs'));
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[shared/kafka] kafkajs is not installed; Kafka helpers will throw if used');
}

const { env } = require('./env');

let kafkaInstance = null;

/**
 * Lazily create a singleton Kafka instance.
 */
function getKafka() {
  if (!Kafka) {
    throw new Error('[shared/kafka] kafkajs is not installed. Install it in this service to use Kafka.');
  }

  if (!kafkaInstance) {
    kafkaInstance = new Kafka({
      clientId: env.KAFKA_CLIENT_ID,
      brokers: env.KAFKA_BROKERS
    });
  }
  return kafkaInstance;
}

/**
 * Create a Kafka producer for emitting events.
 *
 * Example:
 *   const { createKafkaProducer } = require('../../shared/config/kafka');
 *   const producer = createKafkaProducer();
 *   await producer.connect();
 *   await producer.send({ topic, messages: [{ key, value: JSON.stringify(payload) }] });
 */
function createKafkaProducer() {
  return getKafka().producer();
}

/**
 * Create a Kafka consumer for processing events.
 *
 * Example:
 *   const { createKafkaConsumer } = require('../../shared/config/kafka');
 *   const consumer = createKafkaConsumer('wallet-service-group');
 */
function createKafkaConsumer(groupId) {
  return getKafka().consumer({ groupId });
}

module.exports = {
  createKafkaProducer,
  createKafkaConsumer
};