const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../config/db.js');

const router = express.Router();
const matchmakingController = require('../controllers/matchmakingController');

// Update match result
router.put('/match/:matchId/result', matchmakingController.updateMatchResult);

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

// Get match details
router.get('/match/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    const match = await prisma.match.findUnique({
      where: { matchId: matchId }
    });

    if (!match) {
      return res.status(404).json({
        success: false,
        error: 'Match not found'
      });
    }

    // Get session if exists
    let session = null;
    if (match.gameSessionId) {
      session = await prisma.gameSession.findFirst({
        where: { matchId: matchId }
      });
    }

    res.json({
      success: true,
      data: { match, session }
    });
  } catch (error) {
    console.error('Get match error:', error);
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
