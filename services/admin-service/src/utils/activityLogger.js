const logger = require('../utils/logger');
const { prisma } = require('../config/db');

class ActivityLogger {
  static async log(adminId, action, resource, details = {}) {
    try {
      const logData = {
        adminId,
        action,
        resource,
        resourceId: details.resourceId || null,
        details: details,
        ipAddress: details.ipAddress || null,
        userAgent: details.userAgent || null,
        status: 'success'
      };

      await prisma.activityLog.create({ data: logData });
      logger.info(`Admin activity: ${action} on ${resource}`, { adminId, resourceId: details.resourceId });
    } catch (error) {
      logger.error('Failed to log admin activity:', error);
    }
  }

  static async logError(adminId, action, resource, errorMessage, details = {}) {
    try {
      const logData = {
        adminId,
        action,
        resource,
        resourceId: details.resourceId || null,
        details: details,
        ipAddress: details.ipAddress || null,
        userAgent: details.userAgent || null,
        status: 'failed',
        errorMessage
      };

      await prisma.activityLog.create({ data: logData });
      logger.error(`Admin activity failed: ${action} on ${resource}`, { adminId, error: errorMessage });
    } catch (error) {
      logger.error('Failed to log admin error:', error);
    }
  }
}

module.exports = ActivityLogger;
