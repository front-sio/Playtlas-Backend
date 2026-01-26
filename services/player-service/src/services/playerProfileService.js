const { prisma } = require('../config/db');
const logger = require('../utils/logger');

/**
 * Ensure that a player profile exists (and stays updated) for a given userId.
 *
 * @param {object} options
 * @param {string} options.userId - Auth service userId (UUID).
 * @param {string} options.username - Latest username to store.
 * @param {string} [options.agentUserId] - Optional referring agent.
 * @param {Date}  [options.activityAt] - Last activity timestamp.
 * @returns {Promise<{ player: any, created: boolean }>}
 */
async function ensurePlayerProfile({ userId, username, agentUserId, activityAt, clubId }) {
  if (!userId) {
    throw new Error('userId is required to ensure player profile');
  }
  if (!username) {
    throw new Error('username is required to ensure player profile');
  }

  const playerId = userId;
  const existing = await prisma.playerStat.findUnique({
    where: { playerId }
  });

  // Track optional updates only when provided.
  const updateData = {};
  if (agentUserId) {
    updateData.agentUserId = agentUserId;
  }
  if (clubId) {
    updateData.clubId = clubId;
  }
  if (username && (!existing || existing.username !== username)) {
    updateData.username = username;
  }
  if (activityAt) {
    updateData.lastActivityAt = activityAt;
  }

  if (existing) {
    if (Object.keys(updateData).length > 0) {
      const updated = await prisma.playerStat.update({
        where: { playerId },
        data: updateData
      });
      return { player: updated, created: false };
    }
    return { player: existing, created: false };
  }

  const createdPlayer = await prisma.playerStat.create({
    data: {
      playerId,
      userId,
      username,
      agentUserId: agentUserId || null,
      clubId: clubId || null,
      lastActivityAt: activityAt || new Date()
    }
  });

  logger.info(
    { playerId, userId },
    '[playerProfileService] Player profile created'
  );

  return { player: createdPlayer, created: true };
}

module.exports = {
  ensurePlayerProfile
};
