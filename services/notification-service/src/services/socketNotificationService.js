const axios = require('axios');
const logger = require('../utils/logger');

const API_GATEWAY_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';

class SocketNotificationService {
  /**
   * Send notification to a specific user via Socket.IO
   * @param {string} userId - Target user ID
   * @param {object} notification - Notification payload
   */
  async sendToUser(userId, notification) {
    try {
      await axios.post(`${API_GATEWAY_URL}/internal/socket/broadcast`, {
        type: 'user:notification',
        data: {
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
        }
      }, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      logger.info({ userId, type: notification.type }, '[SocketNotificationService] Notification sent to user');
    } catch (error) {
      logger.error({ 
        err: error, 
        userId, 
        notificationType: notification.type 
      }, '[SocketNotificationService] Failed to send notification to user');
      throw error;
    }
  }

  /**
   * Broadcast notification to all users
   * @param {object} notification - Notification payload
   */
  async broadcast(notification) {
    try {
      await axios.post(`${API_GATEWAY_URL}/internal/socket/broadcast`, {
        type: 'global:notification',
        data: {
          notification: {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            data: notification.data || {},
            timestamp: new Date().toISOString(),
            read: false
          }
        }
      }, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      logger.info({ type: notification.type }, '[SocketNotificationService] Notification broadcasted to all users');
    } catch (error) {
      logger.error({ 
        err: error, 
        notificationType: notification.type 
      }, '[SocketNotificationService] Failed to broadcast notification');
      throw error;
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