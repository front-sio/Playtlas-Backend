const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, Topics } = require('../../../../shared/events');

async function handleMatchCompleted(_topic, payload) {
  try {
    const { winnerId, loserId } = payload;
    logger.info(`Processing MATCH_COMPLETED event for winner ${winnerId} and loser ${loserId}`);

    if (!winnerId || !loserId) {
      logger.warn('MATCH_COMPLETED event missing winnerId or loserId');
      return;
    }

    // Update winner
    await prisma.user.update({
      where: { userId: winnerId },
      data: {
        matchesPlayed: { increment: 1 },
        matchesWon: { increment: 1 },
        skillLevel: { increment: 1 },
      },
    });

    // Update loser
    const loser = await prisma.user.findUnique({ where: { userId: loserId } });
    await prisma.user.update({
      where: { userId: loserId },
      data: {
        matchesPlayed: { increment: 1 },
        matchesLost: { increment: 1 },
        skillLevel: loser.skillLevel > 1 ? { decrement: 1 } : { set: 1 },
      },
    });

    logger.info(`Updated stats for winner ${winnerId} and loser ${loserId}`);
  } catch (error) {
    logger.error('Error processing MATCH_COMPLETED event:', error);
  }
}

async function handleWalletCreated(_topic, payload) {
  try {
    const { walletId, ownerId } = payload; // ownerId is the userId
    logger.info(`Processing WALLET_CREATED event for owner ${ownerId} with wallet ${walletId}`);

    if (!walletId || !ownerId) {
      logger.warn('WALLET_CREATED event missing walletId or ownerId');
      return;
    }

    await prisma.user.update({
      where: { userId: ownerId },
      data: { walletId: walletId },
    });

    logger.info(`User ${ownerId}'s walletId updated to ${walletId}`);
  } catch (error) {
    logger.error('Error processing WALLET_CREATED event:', error);
  }
}


const startAuthConsumers = async () => {
  await subscribeEvents(
    'auth-service-group', // Consumer group ID
    [Topics.MATCH_COMPLETED, Topics.WALLET_CREATED], // Subscribe to both topics
    async (topic, payload) => {
      switch (topic) {
        case Topics.MATCH_COMPLETED:
          await handleMatchCompleted(topic, payload);
          break;
        case Topics.WALLET_CREATED:
          await handleWalletCreated(topic, payload);
          break;
        default:
          logger.warn(`Unhandled Kafka topic: ${topic}`);
      }
    }
  );
};

module.exports = { startAuthConsumers };
