const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { prisma } = require('../config/db.js');
const { authMiddleware } = require('../../../../shared/middlewares/authMiddleware');
const matchmakingController = require('../controllers/matchmakingController');

const router = express.Router();
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'http://localhost:3006';

const requireAnyRole = (roles = []) => (req, res, next) => {
  const userRole = String(req.user?.role || '').toLowerCase();
  if (!userRole) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  const allowed = new Set(roles.map((role) => String(role).toLowerCase()));
  if (!allowed.has(userRole)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
};

function normalizeGameType(value) {
  // Only support multiplayer now
  return 'multiplayer';
}

function buildGameTypeFilter(gameType) {
  // Always return empty filter since we only support multiplayer
  return {};
}

function getMatchGameType(match) {
  // Always return multiplayer
  return 'multiplayer';
}

async function fetchMatchSession(match) {
  if (!match?.gameSessionId) return null;
  try {
    const response = await axios.get(`${GAME_SERVICE_URL}/sessions/${match.gameSessionId}`);
    return response?.data?.data || null;
  } catch (err) {
    console.warn('Get match session error:', err?.response?.data?.error || err?.message);
    return null;
  }
}

async function sendMatchResponse(res, match, enforcedGameType) {
  if (!match) {
    return res.status(404).json({
      success: false,
      error: 'Match not found'
    });
  }

  if (enforcedGameType) {
    const normalized = normalizeGameType(enforcedGameType);
    const matchType = getMatchGameType(match);
    if (normalized && normalized !== matchType) {
      return res.status(404).json({
        success: false,
        error: 'Match not found'
      });
    }
  }

  const session = await fetchMatchSession(match);

  return res.json({
    success: true,
    data: { match, session }
  });
}

// Update match result
router.put('/match/:matchId/result', authMiddleware, matchmakingController.updateMatchResult);

router.post('/match/:matchId/result', authMiddleware, matchmakingController.updateMatchResult);

// Update match start time (player/agent/service)
router.post(
  '/match/:matchId/start',
  authMiddleware,
  matchmakingController.updateMatchStart
);

// Host verification flow
router.post(
  '/match/:matchId/host/start',
  authMiddleware,
  matchmakingController.issueHostVerification
);

router.post(
  '/match/:matchId/host/verify',
  authMiddleware,
  matchmakingController.verifyHostQr
);

// Get player's upcoming matches
router.get('/player/:playerId/matches', async (req, res) => {
  try {
    const { playerId } = req.params;
    const { status } = req.query;

    const whereClause = {
      OR: [
        { player1Id: playerId },
        { player2Id: playerId }
      ]
    };

    if (status) {
      whereClause.status = status;
    }

    const playerMatches = await prisma.match.findMany({
      where: whereClause,
      orderBy: {
        scheduledTime: 'desc'
      },
      take: 20
    });

    res.json({
      success: true,
      data: playerMatches
    });
  } catch (error) {
    console.error('Get matches error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Agent assigned matches
router.get(
  '/agent/matches',
  authMiddleware,
  requireAnyRole(['agent', 'service', 'admin', 'super_admin', 'superuser', 'superadmin']),
  async (req, res) => {
    try {
      const agentUserId = req.user?.userId;
      const { status, agentId } = req.query;
      const requesterRole = String(req.user?.role || '').toLowerCase();
      const isService =
        requesterRole === 'service' ||
        requesterRole === 'admin' ||
        requesterRole === 'super_admin' ||
        requesterRole === 'superuser' ||
        requesterRole === 'superadmin';

      if (!agentUserId && !isService) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const whereClause = {};

      if (isService && agentId) {
        whereClause.assignedAgentId = agentId;
      } else if (agentUserId) {
        whereClause.assignedAgentUserId = agentUserId;
      } else {
        return res.status(400).json({ success: false, error: 'agentId is required for service requests' });
      }

      if (status) {
        const statuses = status.split(',').map(s => s.trim());
        if (statuses.length > 1) {
          whereClause.status = { in: statuses };
        } else {
          whereClause.status = statuses[0];
        }
      }

      if (req.query.startDate || req.query.endDate) {
        whereClause.scheduledTime = {};
        if (req.query.startDate) {
          whereClause.scheduledTime.gte = new Date(req.query.startDate);
        }
        if (req.query.endDate) {
          whereClause.scheduledTime.lte = new Date(req.query.endDate);
        }
      }

      const matches = await prisma.match.findMany({
        where: whereClause,
        orderBy: { scheduledTime: 'asc' },
        take: 100
      });

      res.json({ success: true, data: matches });
    } catch (error) {
      console.error('Get agent matches error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// Multiplayer-only matches
router.get('/multiplayer/player/:playerId/matches', async (req, res) => {
  try {
    const { playerId } = req.params;
    const { status } = req.query;

    const whereClause = {
      OR: [
        { player1Id: playerId },
        { player2Id: playerId }
      ],
      ...buildGameTypeFilter('multiplayer')
    };

    if (status) {
      whereClause.status = status;
    }

    const playerMatches = await prisma.match.findMany({
      where: whereClause,
      orderBy: {
        scheduledTime: 'desc'
      },
      take: 20
    });

    res.json({
      success: true,
      data: playerMatches
    });
  } catch (error) {
    console.error('Get multiplayer matches error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get match details
router.get('/match/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    const match = await prisma.match.findUnique({
      where: { matchId: matchId }
    });

    return sendMatchResponse(res, match);
  } catch (error) {
    console.error('Get match error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Bracket view
router.get(
  '/season/:seasonId/bracket',
  authMiddleware,
  matchmakingController.getSeasonBracket
);

router.get('/multiplayer/match/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const match = await prisma.match.findUnique({ where: { matchId } });
    return sendMatchResponse(res, match, 'multiplayer');
  } catch (error) {
    console.error('Get multiplayer match error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get tournament matches (bracket/fixture)
router.get('/tournament/:tournamentId/matches', async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { seasonId, round } = req.query;

    const whereClause = {
      tournamentId: tournamentId
    };

    if (seasonId) {
      whereClause.seasonId = seasonId;
    }

    if (round) {
      whereClause.roundNumber = Number(round);
    }

    const tournamentMatches = await prisma.match.findMany({
      where: whereClause,
      orderBy: {
        scheduledTime: 'asc'
      }
    });

    // Group by round
    const grouped = tournamentMatches.reduce((acc, match) => {
      if (!acc[match.roundNumber]) {
        acc[match.roundNumber] = [];
      }
      acc[match.roundNumber].push(match);
      return acc;
    }, {});

    res.json({
      success: true,
      data: { matches: tournamentMatches, bracket: grouped }
    });
  } catch (error) {
    console.error('Get tournament matches error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Internal: get completed matches for agent/club within date range
router.get('/internal/matches', async (req, res) => {
  try {
    const { clubId, agentId, startDate, endDate, playerIds } = req.query;

    if (!clubId || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'clubId, startDate, and endDate are required'
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    const playerList = playerIds
      ? String(playerIds)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      : [];

    const matches = await prisma.match.findMany({
      where: {
        clubId,
        status: 'completed',
        completedAt: { gte: start, lte: end },
        ...(playerList.length > 0
          ? {
            OR: [
              { player1Id: { in: playerList } },
              { player2Id: { in: playerList } }
            ]
          }
          : {}),
        ...(agentId ? { completedByAgentId: agentId } : {})
      },
      orderBy: { completedAt: 'asc' }
    });

    res.json({
      success: true,
      data: {
        matches: matches.map((match) => ({
          matchId: match.matchId,
          seasonId: match.seasonId,
          deviceId: match.completedByDeviceId || match.assignedDeviceId,
          startedAt: match.startedAt,
          completedAt: match.completedAt,
          durationSeconds: match.matchDuration,
          entryFee: match.metadata?.entryFee || 0,
          gameType: match.metadata?.gameType || null
        }))
      }
    });
  } catch (error) {
    console.error('Get internal matches error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Check queue status
router.get('/queue/:playerId', async (req, res) => {
  try {
    const { playerId } = req.params;

    const queueEntry = await prisma.matchQueue.findUnique({
      where: { playerId: playerId }
    });

    if (!queueEntry) {
      return res.json({
        success: true,
        data: { inQueue: false }
      });
    }

    res.json({
      success: true,
      data: { inQueue: true, queueEntry }
    });
  } catch (error) {
    console.error('Check queue error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Cancel match (admin/timeout)
router.post('/match/:matchId/cancel', async (req, res) => {
  try {
    const { matchId } = req.params;
    const { reason } = req.body;

    await prisma.match.update({
      where: { id: matchId },
      data: {
        status: 'cancelled',
        metadata: JSON.stringify({ cancelReason: reason })
      }
    });

    res.json({
      success: true,
      data: { message: 'Match cancelled' }
    });
  } catch (error) {
    console.error('Cancel match error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


module.exports = router;
