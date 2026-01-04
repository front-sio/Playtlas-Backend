const logger = require('../utils/logger');
const { Topics, subscribeEvents } = require('../../../../shared/events');
const { ensurePlayerProfile } = require('../services/playerProfileService');

function logProcessingResult(topic, startTime, err) {
  const durationMs = Date.now() - startTime;
  if (err) {
    logger.error({ topic, durationMs, err }, '[player-consumers] Event processing failed');
    return;
  }
  if (durationMs > 2000) {
    logger.warn({ topic, durationMs }, '[player-consumers] Slow event processing');
  } else {
    logger.info({ topic, durationMs }, '[player-consumers] Event processed');
  }
}

async function handlePlayerRegistered(payload) {
  const { userId, username, agentUserId } = payload || {};

  if (!userId || !username) {
    logger.warn(
      { payload },
      '[player-consumers] PLAYER_REGISTERED missing userId or username'
    );
    return;
  }

  try {
    const { player, created } = await ensurePlayerProfile({
      userId,
      username,
      agentUserId,
      activityAt: new Date()
    });

    logger.info(
      { playerId: player.playerId, created },
      '[player-consumers] Player profile ensured from PLAYER_REGISTERED event'
    );
  } catch (error) {
    logger.error(
      { err: error, payload },
      '[player-consumers] Failed to ensure player profile from event'
    );
  }
}

async function startPlayerConsumers() {
  let attempt = 0;
  // Keep retrying so event-driven profile creation resumes if Kafka starts late.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await subscribeEvents(
        'player-service',
        [Topics.PLAYER_REGISTERED],
        async (topic, payload) => {
          const startTime = Date.now();
          try {
            if (topic === Topics.PLAYER_REGISTERED) {
              await handlePlayerRegistered(payload);
            }
            logProcessingResult(topic, startTime);
          } catch (err) {
            logProcessingResult(topic, startTime, err);
          }
        }
      );

      logger.info('[player-consumers] Kafka consumers started');
      return;
    } catch (err) {
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
      logger.error({ err, attempt, delay }, '[player-consumers] Failed to subscribe to Kafka, retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = {
  startPlayerConsumers
};
