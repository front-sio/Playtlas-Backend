const axios = require('axios');
const logger = require('../utils/logger');

const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'http://localhost:8081';

class SocketNotificationService {
  /**
   * Send notification to a specific user via Socket.IO
   * @param {string} userId - Target user ID
   * @param {object} notification - Notification payload
   */
  async sendToUser(userId, notification) {
    try {
      // Try to send via game-service socket (if available)
      // This is optional - notifications are primarily stored in DB
      try {
        await axios.post(`${GAME_SERVICE_URL}/api/socket/notify`, {
          userId,
          notification: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            data: notification.data || {},
            timestamp: new Date().toISOString(),
            read: false
          }
        }, {
          timeout: 2000,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        logger.info({ userId, type: notification.type }, '[SocketNotificationService] Notification sent via socket');
      } catch (socketError) {
        // Socket broadcast failed - this is OK, notification is still in DB
        logger.debug({ 
          userId, 
          notificationType: notification.type,
          error: socketError.message 
        }, '[SocketNotificationService] Socket broadcast unavailable, notification stored in DB');
      }
    } catch (error) {
      logger.error({ 
        err: error, 
        userId, 
        notificationType: notification.type 
      }, '[SocketNotificationService] Failed to process notification');
      // Don't throw - notification is already in DB
    }
  }

  /**
   * Broadcast notification to all users
   * @param {object} notification - Notification payload
   */
  async broadcast(notification) {
    try {
      // Try to broadcast via game-service socket (if available)
      try {
        await axios.post(`${GAME_SERVICE_URL}/api/socket/broadcast`, {
          notification: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            data: notification.data || {},
            timestamp: new Date().toISOString(),
            read: false
          }
        }, {
          timeout: 2000,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        logger.info({ type: notification.type }, '[SocketNotificationService] Notification broadcasted via socket');
      } catch (socketError) {
        // Socket broadcast failed - this is OK
        logger.debug({ 
          notificationType: notification.type,
          error: socketError.message 
        }, '[SocketNotificationService] Socket broadcast unavailable');
      }
    } catch (error) {
      logger.error({ 
        err: error, 
        notificationType: notification.type 
      }, '[SocketNotificationService] Failed to process broadcast');
      // Don't throw - notifications can still be retrieved via API
    }
  }

  /**
   * Send notifications to multiple users
   * @param {string[]} userIds - Array of user IDs
   * @param {object} notification - Notification payload
   */
  async sendToMultipleUsers(userIds, notification) {
    const promises = userIds.map(userId => 
      this.sendToUser(userId, notification).catch(err => {
        logger.error({ err, userId }, '[SocketNotificationService] Failed to send to individual user');
        return null; // Continue with other users
      })
    );

    try {
      await Promise.all(promises);
      logger.info({ 
        userCount: userIds.length, 
        type: notification.type 
      }, '[SocketNotificationService] Notifications sent to multiple users');
    } catch (error) {
      logger.error({ 
        err: error, 
        userCount: userIds.length,
        notificationType: notification.type 
      }, '[SocketNotificationService] Some notifications failed to send');
    }
  }
}

module.exports = new SocketNotificationService();