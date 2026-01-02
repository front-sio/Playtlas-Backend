const { subscribeEvents, Topics } = require('../../../../shared/events');
const { enqueueNotification } = require('../../../../shared/utils/notificationHelper');
const { logger } = require('../../../../shared/utils/logger');

async function handleNotificationSend(_topic, payload) {
  // payload already validated by shared event schemas
  try {
    await enqueueNotification(payload, {
      queueName: payload.channel === 'email'
        ? require('../../../../shared/constants/queueNames').QueueNames.NOTIFICATIONS_EMAIL
        : payload.channel === 'sms'
        ? require('../../../../shared/constants/queueNames').QueueNames.NOTIFICATIONS_SMS
        : require('../../../../shared/constants/queueNames').QueueNames.NOTIFICATIONS_IN_APP
    });
  } catch (err) {
    logger.error({ err, payload }, '[notification-consumers] Failed to enqueue notification job');
  }
}

async function handlePrizeCredited(_topic, payload) {
  // Derive a high-level notification event when a prize is credited
  const { publishEvent } = require('../../../../shared/events');

  try {
    await publishEvent(Topics.NOTIFICATION_SEND, {
      userId: payload.winnerId,
      channel: 'in_app',
      type: 'prize',
      title: 'Congratulations! You won a prize',
      message: `You have received ${payload.amount} ${payload.currency} for winning tournament ${payload.tournamentId}.`,
      data: {
        tournamentId: payload.tournamentId,
        seasonId: payload.seasonId,
        walletId: payload.walletId
      }
    });
  } catch (err) {
    logger.error({ err, payload }, '[notification-consumers] Failed to publish NOTIFICATION_SEND for prize');
  }
}

async function startNotificationConsumers() {
  await subscribeEvents('notification-service', [Topics.NOTIFICATION_SEND, Topics.PRIZE_CREDITED], async (topic, payload) => {
    if (topic === Topics.NOTIFICATION_SEND) {
      await handleNotificationSend(topic, payload);
    }
    if (topic === Topics.PRIZE_CREDITED) {
      await handlePrizeCredited(topic, payload);
    }
  });
}

module.exports = {
  startNotificationConsumers
};