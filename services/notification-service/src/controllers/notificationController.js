const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');
const { emitUserNotification } = require('../utils/socketEmitter');

// Send Notification
exports.sendNotification = async (req, res) => {
  try {
    const { userId, type, title, message, data, channel, priority } = req.body;

    if (!userId || !type || !title || !message || !channel) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, type, title, message, channel'
      });
    }

    // Check user preferences
    const prefs = await prisma.notificationPreference.findUnique({
      where: { userId }
    });

    const canSend = checkUserPreferences(prefs, type, channel);

    if (!canSend) {
      logger.info(`Notification blocked by user preferences: ${userId}, ${type}, ${channel}`);
      return res.json({
        success: true,
        message: 'Notification blocked by user preferences'
      });
    }

    // Create notification record
    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        message,
        data: data || {},
        channel,
        priority: priority || 'normal',
        status: 'pending'
      }
    });

    // Send via appropriate channel
    let sendResult;
    try {
      switch (channel) {
        case 'email':
          sendResult = await sendEmailNotification(userId, title, message, data);
          break;
        case 'sms':
          sendResult = await sendSMSNotification(userId, message);
          break;
        case 'push':
          sendResult = await sendPushNotification(userId, title, message, data);
          break;
        case 'in_app':
          sendResult = { success: true };
          break;
        default:
          throw new Error(`Unsupported channel: ${channel}`);
      }

      // Update notification status
      await prisma.notification.update({
        where: { notificationId: notification.notificationId },
        data: {
          status: sendResult.success ? 'sent' : 'failed',
          sentAt: new Date(),
          errorMessage: sendResult.error || null
        }
      });

      if (channel === 'in_app') {
        await emitUserNotification(userId, notification);
      }

      logger.info(`Notification sent: ${notification.notificationId} via ${channel}`);
      res.status(201).json({ success: true, data: notification });
    } catch (sendError) {
      // Update notification as failed
      await prisma.notification.update({
        where: { notificationId: notification.notificationId },
        data: {
          status: 'failed',
          errorMessage: sendError.message,
          retryCount: { increment: 1 }
        }
      });

      logger.error('Notification send failed:', sendError);
      res.status(500).json({
        success: false,
        error: 'Failed to send notification',
        details: sendError.message
      });
    }
  } catch (error) {
    logger.error('Send notification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create notification'
    });
  }
};

// Send Bulk Notifications
exports.sendBulkNotifications = async (req, res) => {
  try {
    const { userIds, type, title, message, data, channel, priority } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'userIds array is required'
      });
    }

    const results = [];

    for (const userId of userIds) {
      try {
        const prefs = await prisma.notificationPreference.findUnique({
          where: { userId }
        });

        if (!checkUserPreferences(prefs, type, channel)) {
          results.push({ userId, success: false, reason: 'blocked by preferences' });
          continue;
        }

        const notification = await prisma.notification.create({
          data: {
            userId,
            type,
            title,
            message,
            data: data || {},
            channel,
            priority: priority || 'normal',
            status: 'pending'
          }
        });

        if (channel === 'in_app') {
          await emitUserNotification(userId, notification);
        }

        results.push({ userId, success: true, notificationId: notification.notificationId });
      } catch (error) {
        results.push({ userId, success: false, error: error.message });
      }
    }

    logger.info(`Bulk notifications created: ${results.length} notifications`);
    res.json({ success: true, data: results });
  } catch (error) {
    logger.error('Bulk notification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send bulk notifications'
    });
  }
};

// Get User Notifications
exports.getUserNotifications = async (req, res) => {
  try {
    const { userId } = req.params;
    const { isRead, type, limit = 50, offset = 0 } = req.query;

    const where = { userId };
    
    if (isRead !== undefined) {
      where.isRead = isRead === 'true';
    }

    if (type) {
      where.type = type;
    }

    const userNotifications = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset)
    });

    res.json({ success: true, data: userNotifications });
  } catch (error) {
    logger.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get notifications'
    });
  }
};

// Mark as Read
exports.markAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;

    await prisma.notification.update({
      where: { notificationId },
      data: {
        isRead: true,
        readAt: new Date()
      }
    });

    logger.info(`Notification marked as read: ${notificationId}`);
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    logger.error('Mark as read error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark notification as read'
    });
  }
};

// Update Preferences
exports.updatePreferences = async (req, res) => {
  try {
    const { userId } = req.params;
    const preferences = req.body;

    const existing = await prisma.notificationPreference.findUnique({
      where: { userId }
    });

    let result;

    if (existing) {
      result = await prisma.notificationPreference.update({
        where: { userId },
        data: preferences
      });
    } else {
      result = await prisma.notificationPreference.create({
        data: { userId, ...preferences }
      });
    }

    logger.info(`Notification preferences updated: ${userId}`);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Update preferences error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update preferences'
    });
  }
};

// Get Preferences
exports.getPreferences = async (req, res) => {
  try {
    const { userId } = req.params;

    const prefs = await prisma.notificationPreference.findUnique({
      where: { userId }
    });

    if (!prefs) {
      // Return default preferences
      return res.json({
        success: true,
        data: {
          userId,
          emailEnabled: true,
          smsEnabled: true,
          pushEnabled: true,
          tournamentUpdates: true,
          matchReminders: true,
          paymentAlerts: true,
          marketingEmails: false
        }
      });
    }

    res.json({ success: true, data: prefs });
  } catch (error) {
    logger.error('Get preferences error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get preferences'
    });
  }
};

// Helper Functions
function checkUserPreferences(prefs, type, channel) {
  if (!prefs) return true; // Default allow if no preferences set

  // Check channel preference
  if (channel === 'email' && !prefs.emailEnabled) return false;
  if (channel === 'sms' && !prefs.smsEnabled) return false;
  if (channel === 'push' && !prefs.pushEnabled) return false;

  // Check type preference
  if (type === 'tournament' && !prefs.tournamentUpdates) return false;
  if (type === 'match' && !prefs.matchReminders) return false;
  if (type === 'payment' && !prefs.paymentAlerts) return false;
  if (type === 'marketing' && !prefs.marketingEmails) return false;

  return true;
}

async function sendEmailNotification(userId, title, message, data) {
  try {
    // Get user email from auth service
    const email = data?.email || 'masanja.developer@gmail.com'; // Would fetch from auth service
    await emailService.send(email, title, message, message);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function sendSMSNotification(userId, message) {
  try {
    // Get user phone from auth service
    const phone = '+255712345678'; // Would fetch from auth service
    await smsService.send(phone, message);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function sendPushNotification(userId, title, message, data) {
  try {
    // Implement push notification logic (Firebase, OneSignal, etc.)
    logger.info(`[SIMULATED PUSH] User: ${userId}, Title: ${title}, Message: ${message}`);
    return { success: true, simulated: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = exports;
