const logger = require('../utils/logger');
const { prisma } = require('../config/db');
const { ensurePlayerProfile } = require('./playerProfileService');

class PlayerService {
  /**
   * Ensure a player profile exists for a user that was onboarded by an agent.
   *
   * @param {object} params
   * @param {string} params.agentUserId
   * @param {string} params.playerUserId
   * @param {string} [params.username]
   */
  async registerPlayerByAgent({ agentUserId, playerUserId, username }) {
    if (!agentUserId || !playerUserId) {
      throw new Error('agentUserId and playerUserId are required');
    }

    const resolvedUsername =
      username || `player_${playerUserId.substring(0, 8)}`;

    const { player } = await ensurePlayerProfile({
      userId: playerUserId,
      username: resolvedUsername,
      agentUserId,
      activityAt: new Date()
    });

    logger.info(
      { playerId: player.playerId, agentUserId },
      '[playerService] Player registered via agent'
    );

    return player;
  }

  /**
   * Remove an agent association from a player profile.
   *
   * @param {string} playerUserId
   */
  async detachAgent(playerUserId) {
    if (!playerUserId) {
      throw new Error('playerUserId is required');
    }

    let player;
    try {
      player = await prisma.playerStat.update({
        where: { playerId: playerUserId },
        data: { agentUserId: null, updatedAt: new Date() }
      });
    } catch (err) {
      logger.error(
        { err, playerUserId },
        '[playerService] Failed to detach agent from player'
      );
      throw err;
    }

    logger.info(
      { playerId: playerUserId },
      '[playerService] Agent detached from player profile'
    );

    return player;
  }
}

module.exports = new PlayerService();
