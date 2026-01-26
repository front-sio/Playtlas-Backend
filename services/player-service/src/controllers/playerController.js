const { ensurePlayerProfile } = require('../services/playerProfileService');
const logger = require('../utils/logger');
const { prisma } = require('../config/db');
const { Prisma } = require('@prisma/client');
const TOURNAMENT_SERVICE_URL = process.env.TOURNAMENT_SERVICE_URL || 'http://tournament-service:3000';

// const { authenticate, authorize } = require('./authMiddleware'); // Commented out - middleware doesn't exist yet

async function fetchClubTournaments(clubId) {
  if (!clubId) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(
      `${TOURNAMENT_SERVICE_URL}/tournament?clubId=${encodeURIComponent(clubId)}`,
      { signal: controller.signal }
    );
    if (!response.ok) {
      logger.warn('[playerController] Tournament service responded with non-200');
      return [];
    }
    const payload = await response.json();
    return Array.isArray(payload?.data) ? payload.data : [];
  } catch (error) {
    const isAbort = error?.name === 'AbortError';
    logger.warn('[playerController] Failed to fetch club tournaments', {
      clubId,
      message: isAbort ? 'timeout' : error?.message
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

exports.createOrUpdatePlayer = async (req, res) => {
  const isDev = (process.env.NODE_ENV || 'development') !== 'production';
  try {
    const { playerId, userId, username, agentUserId, clubId } = req.body;
    const effectivePlayerId = playerId || userId;

    if (!effectivePlayerId || !username) {
      return res.status(400).json({
        success: false,
        error: 'playerId and username are required',
        hint: isDev ? 'Send { "playerId": "<auth userId>", "username": "<username>" }' : undefined,
      });
    }

    const { player, created } = await ensurePlayerProfile({
      userId: effectivePlayerId,
      username,
      agentUserId,
      clubId,
      activityAt: new Date()
    });

    logger.info(
      { playerId: player.playerId, created },
      '[playerController] Player profile ensured via API'
    );

    res.status(created ? 201 : 200).json({ success: true, data: player });
  } catch (error) {
    logger.error('[playerController] Create player error:', {
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to create player stats',
      details: isDev ? error?.message : undefined,
      code: isDev ? error?.code : undefined,
    });
  }
};

exports.getPlayerStats = async (req, res) => {
  const isDev = (process.env.NODE_ENV || 'development') !== 'production';
  try {
    const playerId = req.params.playerId;
    const player = await prisma.playerStat.findUnique({ where: { playerId } });

    if (!player) {
      return res.status(404).json({ success: false, error: 'Player not found' });
    }

    let recentMatches = [];
    try {
      recentMatches = await prisma.matchHistory.findMany({
        where: { playerId },
        orderBy: { playedAt: 'desc' },
        take: 10,
      });
    } catch (e) {
      logger.error('[playerController] Failed to query match history', {
        message: e?.message,
        code: e?.code,
      });
      recentMatches = [];
    }

    let achievements = [];
    try {
      achievements = await prisma.achievement.findMany({
        where: { playerId },
        orderBy: { earnedAt: 'desc' },
      });
    } catch (e) {
      logger.error('[playerController] Failed to query achievements', {
        message: e?.message,
        code: e?.code,
      });
      achievements = [];
    }

    let clubTournaments = [];
    try {
      clubTournaments = await fetchClubTournaments(player.clubId);
    } catch (e) {
      clubTournaments = [];
    }

    res.json({
      success: true,
      data: {
        ...player,
        recentMatches,
        achievements,
        clubTournaments
      },
    });
  } catch (error) {
    logger.error('[playerController] Get player stats error:', {
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
    });

    const code = error?.code;
    const isSchemaIssue = code === 'P2021' || code === 'P2022';

    res.status(500).json({
      success: false,
      error: isSchemaIssue ? 'Player database schema not initialized' : 'Failed to get player stats',
      details: isDev ? error?.message : undefined,
      code: isDev ? code : undefined,
    });
  }
};

exports.getAgentAnalytics = async (req, res) => {
  try {
    const { agentUserId } = req.params;
    const { clubId, startDate, endDate } = req.query;

    if (!agentUserId) {
      return res.status(400).json({ success: false, error: 'agentUserId is required' });
    }

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const where = { agentUserId };
    if (clubId) where.clubId = clubId;

    const players = await prisma.playerStat.findMany({
      where,
      select: { playerId: true, createdAt: true }
    });

    const playerIds = players.map((p) => p.playerId);
    if (playerIds.length === 0) {
      return res.json({
        success: true,
        data: {
          agentUserId,
          clubId: clubId || null,
          period: { startDate: start, endDate: end },
          registeredPlayers: 0,
          participatingPlayers: 0,
          matchesPlayed: 0
        }
      });
    }

    const matches = await prisma.matchHistory.findMany({
      where: {
        playerId: { in: playerIds },
        playedAt: { gte: start, lte: end }
      },
      select: { playerId: true }
    });

    const participatingPlayers = new Set(matches.map((m) => m.playerId)).size;

    res.json({
      success: true,
      data: {
        agentUserId,
        clubId: clubId || null,
        period: { startDate: start, endDate: end },
        registeredPlayers: playerIds.length,
        participatingPlayers,
        matchesPlayed: matches.length
      }
    });
  } catch (error) {
    logger.error('[playerController] Agent analytics error:', {
      message: error?.message,
      stack: error?.stack
    });
    res.status(500).json({ success: false, error: 'Failed to fetch agent analytics' });
  }
};

exports.updateMatchResult = async (req, res) => {
  try {
    const { playerId, matchId, tournamentId, opponentId, result, pointsChange = 0, matchData } = req.body;

    if (!playerId || !matchId || !tournamentId || !opponentId || !result) {
      return res.status(400).json({
        success: false,
        error: 'playerId, matchId, tournamentId, opponentId, and result are required',
      });
    }

    const numericPointsChange = Number(pointsChange) || 0;
    const normalizedResult = String(result).toLowerCase();
    const isWin = normalizedResult === 'win';

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.playerStat.findUnique({ where: { playerId } });
      if (!current) {
        throw new Error('Player not found');
      }

      await tx.matchHistory.create({
        data: {
          playerId,
          matchId,
          tournamentId,
          opponentId,
          result: normalizedResult,
          pointsChange: numericPointsChange,
          matchData: matchData ?? undefined,
        },
      });

      const totalMatches = current.totalMatches + 1;
      const matchesWon = current.matchesWon + (isWin ? 1 : 0);
      const matchesLost = current.matchesLost + (isWin ? 0 : 1);
      const currentStreak = isWin ? current.currentStreak + 1 : 0;
      const longestStreak = isWin ? Math.max(current.longestStreak, currentStreak) : current.longestStreak;
      const rankingPoints = current.rankingPoints + numericPointsChange;
      const winRate = totalMatches > 0 ? (matchesWon / totalMatches) * 100 : 0;

      return tx.playerStat.update({
        where: { playerId },
        data: {
          totalMatches,
          matchesWon,
          matchesLost,
          currentStreak,
          longestStreak,
          rankingPoints,
          winRate: new Prisma.Decimal(winRate.toFixed(2)),
          updatedAt: new Date(),
          lastActivityAt: new Date(),
        },
      });
    });

    logger.info({ playerId, matchId, result }, '[playerController] Match result applied');
    res.json({ success: true, data: updated });
  } catch (error) {
    if (error?.message === 'Player not found') {
      return res.status(404).json({ success: false, error: 'Player not found' });
    }
    logger.error('Update match result error:', error);
    res.status(500).json({ success: false, error: 'Failed to update stats' });
  }
};

exports.getLeaderboard = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const leaderboard = await prisma.playerStat.findMany({
      orderBy: { rankingPoints: 'desc' },
      take: limit,
      skip: offset,
    });

    // Add computed rank in response (avoid writing ranks on every request)
    const withRanks = leaderboard.map((p, idx) => ({
      ...p,
      rank: offset + idx + 1,
    }));

    res.json({ success: true, data: withRanks });
  } catch (error) {
    logger.error('Get leaderboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to get leaderboard' });
  }
};

exports.addAchievement = async (req, res) => {
  try {
    const { playerId, achievementType, title, description } = req.body;

    if (!playerId || !achievementType || !title) {
      return res.status(400).json({
        success: false,
        error: 'playerId, achievementType, and title are required',
      });
    }

    // Applying authenticate and authorize middleware for awarding achievements
    // Only specific roles (e.g., admin, game_master) should be able to award achievements.
    // if (!['admin', 'game_master'].includes(req.user.role)) { // Check if role is allowed
    //    return res.status0(403).json({ success: false, error: 'Forbidden: Insufficient role permissions to award achievements.' });
    // }

    const achievement = await prisma.achievement.create({
      data: {
        playerId,
        achievementType,
        title,
        description: description ?? null,
      },
    });

    logger.info(`Achievement awarded to ${playerId}: ${title}`);
    res.status(201).json({ success: true, data: achievement });
  } catch (error) {
    logger.error('Add achievement error:', error);
    res.status(500).json({ success: false, error: 'Failed to add achievement' });
  }
};
