const { subscribeEvents, Topics, publishEvent } = require('../../../../shared/events');
const { enqueueNotification } = require('../../../../shared/utils/notificationHelper');
const { logger } = require('../../../../shared/utils/logger');
const socketNotificationService = require('../services/socketNotificationService');

async function handleNotificationSend(_topic, payload) {
  // payload already validated by shared event schemas
  try {
    // Handle real-time socket notifications
    if (payload.userId) {
      // Send to specific user
      await socketNotificationService.sendToUser(payload.userId, payload);
    } else {
      // Broadcast to all users
      await socketNotificationService.broadcast(payload);
    }

    // Also enqueue for other channels (email, SMS, push, etc.)
    if (payload.channel !== 'in_app') {
      await enqueueNotification(payload, {
        queueName: payload.channel === 'email'
          ? require('../../../../shared/constants/queueNames').QueueNames.NOTIFICATIONS_EMAIL
          : payload.channel === 'sms'
          ? require('../../../../shared/constants/queueNames').QueueNames.NOTIFICATIONS_SMS
          : require('../../../../shared/constants/queueNames').QueueNames.NOTIFICATIONS_IN_APP
      });
    }
  } catch (err) {
    logger.error({ err, payload }, '[notification-consumers] Failed to handle notification');
  }
}

async function handleSeasonCreated(_topic, payload) {
  // Get list of players who have participated in tournaments recently
  const { prisma } = require('../config/db');

  try {
    // Get all players who have joined tournaments in the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentPlayers = await prisma.tournamentPlayer.findMany({
      where: {
        createdAt: {
          gte: thirtyDaysAgo
        }
      },
      select: {
        playerId: true
      },
      distinct: ['playerId']
    });

    const playerIds = recentPlayers.map(p => p.playerId);
    
    // Also get players who specifically joined this tournament before
    const tournamentPlayers = await prisma.tournamentPlayer.findMany({
      where: {
        tournamentId: payload.tournamentId
      },
      select: {
        playerId: true
      },
      distinct: ['playerId']
    });

    const tournamentPlayerIds = tournamentPlayers.map(p => p.playerId);
    const allTargetPlayers = [...new Set([...playerIds, ...tournamentPlayerIds])];

    // Send individual notifications to each targeted player
    for (const playerId of allTargetPlayers) {
      await publishEvent(Topics.NOTIFICATION_SEND, {
        userId: playerId,
        channel: 'in_app',
        type: 'new_season',
        title: 'New Tournament Season Available!',
        message: `${payload.name} is now open for registration. Join now to compete!`,
        data: {
          tournamentId: payload.tournamentId,
          seasonId: payload.seasonId,
          startTime: payload.startTime,
          joinDeadline: payload.joinDeadline,
          action: 'join_season'
        }
      });
    }

    // Also send a general broadcast notification
    await publishEvent(Topics.NOTIFICATION_SEND, {
      userId: null, // null means broadcast to all users
      channel: 'in_app',
      type: 'new_season_broadcast',
      title: 'New Tournament Season Available!',
      message: `${payload.name} is now open for registration. Join now to compete!`,
      data: {
        tournamentId: payload.tournamentId,
        seasonId: payload.seasonId,
        startTime: payload.startTime,
        joinDeadline: payload.joinDeadline,
        action: 'join_season'
      }
    });
    
    logger.info({ 
      seasonId: payload.seasonId, 
      tournamentId: payload.tournamentId,
      targetedPlayers: allTargetPlayers.length
    }, '[notification-consumers] Season created notifications sent');
  } catch (err) {
    logger.error({ err, payload }, '[notification-consumers] Failed to send new season notifications');
  }
}

async function handleMatchReady(_topic, payload) {
  // Notify both players that their match is ready

  try {
    const scheduledTime = payload.scheduledTime ? new Date(payload.scheduledTime) : new Date();
    const timeStr = scheduledTime.toLocaleString();

    // Notify Player 1
    await publishEvent(Topics.NOTIFICATION_SEND, {
      userId: payload.player1Id,
      channel: 'in_app',
      type: 'match_ready',
      title: 'Your Match is Ready!',
      message: `Your tournament match is scheduled for ${timeStr}. Click to join and play!`,
      data: {
        matchId: payload.matchId,
        tournamentId: payload.tournamentId,
        seasonId: payload.seasonId,
        opponentId: payload.player2Id,
        scheduledTime: payload.scheduledTime,
        gameSessionId: payload.gameSessionId,
        action: 'join_match'
      }
    });

    // Notify Player 2
    await publishEvent(Topics.NOTIFICATION_SEND, {
      userId: payload.player2Id,
      channel: 'in_app',
      type: 'match_ready',
      title: 'Your Match is Ready!',
      message: `Your tournament match is scheduled for ${timeStr}. Click to join and play!`,
      data: {
        matchId: payload.matchId,
        tournamentId: payload.tournamentId,
        seasonId: payload.seasonId,
        opponentId: payload.player1Id,
        scheduledTime: payload.scheduledTime,
        gameSessionId: payload.gameSessionId,
        action: 'join_match'
      }
    });
    
    logger.info({ 
      matchId: payload.matchId,
      player1Id: payload.player1Id,
      player2Id: payload.player2Id
    }, '[notification-consumers] Match ready notifications sent');
  } catch (err) {
    logger.error({ err, payload }, '[notification-consumers] Failed to publish NOTIFICATION_SEND for match ready');
  }
}

async function handlePrizeCredited(_topic, payload) {
  // Derive a high-level notification event when a prize is credited

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
  await subscribeEvents('notification-service', [
    Topics.NOTIFICATION_SEND, 
    Topics.PRIZE_CREDITED, 
    Topics.SEASON_CREATED, 
    Topics.MATCH_READY
  ], async (topic, payload) => {
    if (topic === Topics.NOTIFICATION_SEND) {
      await handleNotificationSend(topic, payload);
    }
    if (topic === Topics.PRIZE_CREDITED) {
      await handlePrizeCredited(topic, payload);
    }
    if (topic === Topics.SEASON_CREATED) {
      await handleSeasonCreated(topic, payload);
    }
    if (topic === Topics.MATCH_READY) {
      await handleMatchReady(topic, payload);
    }
  });
}

module.exports = {
  startNotificationConsumers
};