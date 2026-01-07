const { subscribeEvents, publishEvent, Topics } = require('../../../../shared/events');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');

const ADMIN_NOTIFY_ROLES = [
  'admin',
  'super_admin',
  'superuser',
  'superadmin',
  'finance_manager',
  'manager',
  'director',
  'staff',
  'tournament_manager',
  'game_manager',
  'game_master'
];

async function handlePlayerRegistered(payload) {
  const { userId, username, email, phoneNumber } = payload || {};
  if (!userId) return;

  const admins = await prisma.adminUser.findMany({
    where: {
      isActive: true,
      role: { in: ADMIN_NOTIFY_ROLES }
    },
    select: { userId: true, role: true }
  });

  if (!admins.length) return;

  const displayName = username || email || phoneNumber || userId;
  await Promise.all(
    admins.map((admin) =>
      publishEvent(Topics.NOTIFICATION_SEND, {
        userId: admin.userId,
        channel: 'in_app',
        type: 'admin_alert',
        title: 'New player registered',
        message: `New player registered: ${displayName}.`,
        data: {
          playerId: userId,
          username,
          email,
          phoneNumber,
          role: admin.role
        }
      }).catch((err) => {
        logger.error({ err, adminUserId: admin.userId, playerId: userId }, '[admin-notify] Failed to publish notification');
      })
    )
  );
}

async function startAdminNotificationConsumer() {
  await subscribeEvents('admin-service', [Topics.PLAYER_REGISTERED], async (_topic, payload) => {
    try {
      await handlePlayerRegistered(payload);
    } catch (err) {
      logger.error({ err, payload }, '[admin-notify] Failed to handle PLAYER_REGISTERED');
    }
  });
  logger.info('[admin-notify] Consumer started');
}

module.exports = {
  startAdminNotificationConsumer
};
