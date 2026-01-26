const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { BracketBuilder } = require('../services/BracketBuilder');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();
const bracketBuilder = new BracketBuilder();

// Agent API routes - control match execution and results

/**
 * Middleware to verify agent authorization
 */
const verifyAgentAccess = async (req, res, next) => {
  try {
    const agentId = req.user?.agentId || req.user?.userId;
    const { matchId } = req.params;

    if (!agentId) {
      return res.status(401).json({
        success: false,
        error: 'Agent authentication required'
      });
    }

    // Verify agent is assigned to this match
    const match = await prisma.match.findUnique({
      where: { matchId }
    });

    if (!match) {
      return res.status(404).json({
        success: false,
        error: 'Match not found'
      });
    }

    if (match.assignedAgentId !== agentId) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized for this match'
      });
    }

    req.match = match;
    next();
  } catch (error) {
    logger.error({ err: error }, '[AgentAPI] Authorization check failed');
    res.status(500).json({
      success: false,
      error: 'Authorization check failed'
    });
  }
};

/**
 * GET /api/agent/matches
 * Get matches assigned to this agent
 */
router.get('/matches', async (req, res) => {
  try {
    const agentId = req.user?.agentId || req.user?.userId;
    const { status, date } = req.query;

    if (!agentId) {
      return res.status(401).json({
        success: false,
        error: 'Agent authentication required'
      });
    }

    // Build where clause
    const whereClause = {
      assignedAgentId: agentId
    };

    if (status) {
      whereClause.status = status;
    }

    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      
      whereClause.scheduledStartAt = {
        gte: startOfDay,
        lte: endOfDay
      };
    }

    const matches = await prisma.match.findMany({
      where: whereClause,
      include: {
        tournament: true,
        season: true
      },
      orderBy: { scheduledStartAt: 'asc' }
    });

    // Format matches with additional context
    const formattedMatches = matches.map(match => ({
      matchId: match.matchId,
      tournamentName: match.tournament.name,
      seasonNumber: match.season.seasonNumber,
      round: match.round,
      groupLabel: match.groupLabel,
      matchNumber: match.matchNumber,
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      player1Score: match.player1Score,
      player2Score: match.player2Score,
      winnerId: match.winnerId,
      status: match.status,
      scheduledStartAt: match.scheduledStartAt,
      assignedDeviceId: match.assignedDeviceId,
      startedAt: match.startedAt,
      completedAt: match.completedAt,
      matchDurationSeconds: match.matchDurationSeconds,
      endReason: match.endReason,
      // Status flags
      canStart: match.status === 'READY' || match.status === 'SCHEDULED',
      canComplete: match.status === 'IN_PROGRESS',
      isOverdue: match.scheduledStartAt && match.scheduledStartAt < new Date() && match.status === 'SCHEDULED',
      // Timing
      timeUntilStart: match.scheduledStartAt ? Math.max(0, match.scheduledStartAt.getTime() - Date.now()) : null
    }));

    // Group matches by status for easier agent workflow
    const groupedMatches = {
      ready: formattedMatches.filter(m => m.status === 'READY'),
      scheduled: formattedMatches.filter(m => m.status === 'SCHEDULED'),
      inProgress: formattedMatches.filter(m => m.status === 'IN_PROGRESS'),
      completed: formattedMatches.filter(m => m.status === 'COMPLETED'),
      overdue: formattedMatches.filter(m => m.isOverdue)
    };

    res.json({
      success: true,
      data: {
        agentId,
        matches: formattedMatches,
        groupedMatches,
        summary: {
          total: formattedMatches.length,
          ready: groupedMatches.ready.length,
          scheduled: groupedMatches.scheduled.length,
          inProgress: groupedMatches.inProgress.length,
          completed: groupedMatches.completed.length,
          overdue: groupedMatches.overdue.length
        }
      }
    });

  } catch (error) {
    logger.error({ err: error }, '[AgentAPI] Failed to get agent matches');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve matches'
    });
  }
});

/**
 * POST /api/agent/matches/:matchId/start
 * Start a match (only assigned agent can start)
 */
router.post('/matches/:matchId/start', verifyAgentAccess, async (req, res) => {
  try {
    const { matchId } = req.params;
    const match = req.match;

    // Verify match can be started
    if (match.status !== 'READY' && match.status !== 'SCHEDULED') {
      return res.status(400).json({
        success: false,
        error: `Cannot start match in ${match.status} status`
      });
    }

    // Verify both players are assigned (for knockout matches)
    if (!match.player1Id || !match.player2Id) {
      return res.status(400).json({
        success: false,
        error: 'Both players must be assigned before starting match'
      });
    }

    // Start the match
    const updatedMatch = await prisma.match.update({
      where: { matchId },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date()
      }
    });

    // Update device schedule status
    await prisma.deviceSchedule.updateMany({
      where: { matchId },
      data: { status: 'IN_USE' }
    });

    logger.info({ 
      matchId, 
      agentId: match.assignedAgentId,
      player1Id: match.player1Id,
      player2Id: match.player2Id
    }, '[AgentAPI] Match started');

    res.json({
      success: true,
      data: {
        matchId,
        status: updatedMatch.status,
        startedAt: updatedMatch.startedAt,
        message: 'Match started successfully'
      }
    });

  } catch (error) {
    logger.error({ err: error, matchId: req.params.matchId }, '[AgentAPI] Failed to start match');
    res.status(500).json({
      success: false,
      error: 'Failed to start match'
    });
  }
});

/**
 * POST /api/agent/matches/:matchId/complete
 * Complete a match with results (only assigned agent can complete)
 */
router.post('/matches/:matchId/complete', verifyAgentAccess, async (req, res) => {
  try {
    const { matchId } = req.params;
    const match = req.match;
    const { 
      winnerId, 
      player1Score, 
      player2Score, 
      endReason,
      matchDurationSeconds 
    } = req.body;

    // Validate input
    if (!winnerId || typeof player1Score !== 'number' || typeof player2Score !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'winnerId, player1Score, and player2Score are required'
      });
    }

    // Verify match can be completed
    if (match.status !== 'IN_PROGRESS') {
      return res.status(400).json({
        success: false,
        error: `Cannot complete match in ${match.status} status`
      });
    }

    // Verify winner is one of the players
    if (winnerId !== match.player1Id && winnerId !== match.player2Id) {
      return res.status(400).json({
        success: false,
        error: 'Winner must be one of the match players'
      });
    }

    // Calculate match duration if not provided
    const actualDuration = matchDurationSeconds || 
      (match.startedAt ? Math.floor((Date.now() - match.startedAt.getTime()) / 1000) : 300);

    // Complete the match
    const updatedMatch = await prisma.match.update({
      where: { matchId },
      data: {
        winnerId,
        player1Score,
        player2Score,
        status: 'COMPLETED',
        completedAt: new Date(),
        matchDurationSeconds: actualDuration,
        endReason: endReason || '8ball_potted',
        gameData: {
          completedBy: 'agent',
          agentId: match.assignedAgentId,
          deviceId: match.assignedDeviceId,
          endReason: endReason || '8ball_potted',
          scores: { player1Score, player2Score },
          submittedAt: new Date().toISOString()
        }
      }
    });

    // Update device schedule status
    await prisma.deviceSchedule.updateMany({
      where: { matchId },
      data: { status: 'AVAILABLE' }
    });

    // Trigger bracket updates
    await bracketBuilder.updateBracketOnMatchCompletion(matchId);

    logger.info({ 
      matchId, 
      winnerId,
      scores: `${player1Score}-${player2Score}`,
      duration: actualDuration,
      agentId: match.assignedAgentId
    }, '[AgentAPI] Match completed');

    res.json({
      success: true,
      data: {
        matchId,
        winnerId,
        player1Score,
        player2Score,
        status: updatedMatch.status,
        completedAt: updatedMatch.completedAt,
        matchDurationSeconds: actualDuration,
        message: 'Match completed successfully'
      }
    });

  } catch (error) {
    logger.error({ err: error, matchId: req.params.matchId }, '[AgentAPI] Failed to complete match');
    res.status(500).json({
      success: false,
      error: 'Failed to complete match'
    });
  }
});

/**
 * POST /api/agent/matches/:matchId/cancel
 * Cancel a match (for no-shows, technical issues, etc.)
 */
router.post('/matches/:matchId/cancel', verifyAgentAccess, async (req, res) => {
  try {
    const { matchId } = req.params;
    const match = req.match;
    const { reason } = req.body;

    // Verify match can be cancelled
    if (match.status === 'COMPLETED') {
      return res.status(400).json({
        success: false,
        error: 'Cannot cancel completed match'
      });
    }

    // Cancel the match
    const updatedMatch = await prisma.match.update({
      where: { matchId },
      data: {
        status: 'CANCELLED',
        endReason: reason || 'cancelled_by_agent',
        gameData: {
          cancelledBy: 'agent',
          agentId: match.assignedAgentId,
          reason: reason || 'cancelled_by_agent',
          cancelledAt: new Date().toISOString()
        }
      }
    });

    // Free up device schedule
    await prisma.deviceSchedule.updateMany({
      where: { matchId },
      data: { status: 'AVAILABLE' }
    });

    logger.info({ 
      matchId, 
      reason,
      agentId: match.assignedAgentId
    }, '[AgentAPI] Match cancelled');

    res.json({
      success: true,
      data: {
        matchId,
        status: updatedMatch.status,
        reason: reason || 'cancelled_by_agent',
        message: 'Match cancelled successfully'
      }
    });

  } catch (error) {
    logger.error({ err: error, matchId: req.params.matchId }, '[AgentAPI] Failed to cancel match');
    res.status(500).json({
      success: false,
      error: 'Failed to cancel match'
    });
  }
});

/**
 * GET /api/agent/matches/:matchId
 * Get detailed match information
 */
router.get('/matches/:matchId', verifyAgentAccess, async (req, res) => {
  try {
    const { matchId } = req.params;
    
    const match = await prisma.match.findUnique({
      where: { matchId },
      include: {
        tournament: true,
        season: true,
        advancesToMatch: {
          select: {
            matchId: true,
            round: true,
            matchNumber: true
          }
        }
      }
    });

    const detailedMatch = {
      matchId: match.matchId,
      tournament: {
        tournamentId: match.tournament.tournamentId,
        name: match.tournament.name,
        operatingHours: {
          start: match.tournament.operatingHoursStart,
          end: match.tournament.operatingHoursEnd
        },
        matchDurationMinutes: match.tournament.matchDurationMinutes
      },
      season: {
        seasonId: match.season.seasonId,
        seasonNumber: match.season.seasonNumber,
        name: match.season.name
      },
      round: match.round,
      groupLabel: match.groupLabel,
      matchNumber: match.matchNumber,
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      player1Score: match.player1Score,
      player2Score: match.player2Score,
      winnerId: match.winnerId,
      status: match.status,
      scheduledStartAt: match.scheduledStartAt,
      assignedDeviceId: match.assignedDeviceId,
      assignedAgentId: match.assignedAgentId,
      startedAt: match.startedAt,
      completedAt: match.completedAt,
      matchDurationSeconds: match.matchDurationSeconds,
      endReason: match.endReason,
      gameData: match.gameData,
      progression: {
        advancesToMatchId: match.winnerAdvancesToMatchId,
        advancesToSlot: match.winnerAdvancesToSlot,
        nextMatch: match.advancesToMatch
      },
      // Control flags
      canStart: match.status === 'READY' || match.status === 'SCHEDULED',
      canComplete: match.status === 'IN_PROGRESS',
      canCancel: match.status !== 'COMPLETED'
    };

    res.json({
      success: true,
      data: detailedMatch
    });

  } catch (error) {
    logger.error({ err: error, matchId: req.params.matchId }, '[AgentAPI] Failed to get match details');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve match details'
    });
  }
});

/**
 * GET /api/agent/device/:deviceId/schedule
 * Get device schedule for agent's device
 */
router.get('/device/:deviceId/schedule', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { date } = req.query;
    const agentId = req.user?.agentId || req.user?.userId;

    // Verify agent owns this device (simplified check)
    // In production, this would verify through agent-service

    let startDate, endDate;
    if (date) {
      startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
    } else {
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date();
      endDate.setHours(23, 59, 59, 999);
    }

    const schedule = await prisma.deviceSchedule.findMany({
      where: {
        deviceId,
        startTime: { gte: startDate },
        endTime: { lte: endDate }
      },
      include: {
        match: {
          include: {
            tournament: true,
            season: true
          }
        }
      },
      orderBy: { startTime: 'asc' }
    });

    const formattedSchedule = schedule.map(slot => ({
      scheduleId: slot.scheduleId,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: slot.status,
      match: slot.match ? {
        matchId: slot.match.matchId,
        tournamentName: slot.match.tournament.name,
        seasonNumber: slot.match.season.seasonNumber,
        round: slot.match.round,
        groupLabel: slot.match.groupLabel,
        player1Id: slot.match.player1Id,
        player2Id: slot.match.player2Id,
        status: slot.match.status
      } : null
    }));

    res.json({
      success: true,
      data: {
        deviceId,
        date: date || new Date().toISOString().split('T')[0],
        schedule: formattedSchedule,
        totalSlots: formattedSchedule.length,
        availableSlots: formattedSchedule.filter(s => s.status === 'AVAILABLE').length,
        bookedSlots: formattedSchedule.filter(s => s.status === 'BOOKED').length,
        inUseSlots: formattedSchedule.filter(s => s.status === 'IN_USE').length
      }
    });

  } catch (error) {
    logger.error({ err: error, deviceId: req.params.deviceId }, '[AgentAPI] Failed to get device schedule');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve device schedule'
    });
  }
});

module.exports = router;