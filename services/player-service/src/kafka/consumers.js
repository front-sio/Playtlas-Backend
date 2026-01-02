const logger = require('../utils/logger');
const { Topics, subscribeEvents } = require('../../../../shared/events');
const { ensurePlayerProfile } = require('../services/playerProfileService');

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
  await subscribeEvents(
    'player-service',
    [Topics.PLAYER_REGISTERED],
    async (topic, payload) => {
      if (topic === Topics.PLAYER_REGISTERED) {
        await handlePlayerRegistered(payload);
      }
    }
  );

  logger.info('[player-consumers] Kafka consumers started');
}

module.exports = {
  startPlayerConsumers
};
