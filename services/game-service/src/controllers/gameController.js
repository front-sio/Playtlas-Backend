// backend/services/game-service/src/controllers/gameController.js
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { QueueNames } = require('../../../../shared/constants/queueNames');
const { createQueue, defaultJobOptions } = require('../../../../shared/config/redis');

let cleanupQueue;

function getCleanupQueue() {
  if (!cleanupQueue) {
    cleanupQueue = createQueue(QueueNames.GAME_SESSION_CLEANUP);
  }
  return cleanupQueue;
}

function safeParseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      return {};
    }
  }
  if (typeof value === 'object') return value;
  return {};
}

exports.createSession = async (req, res) => {
  try {
    const { tableId, player1Id, player2Id, metadata } = req.body;

    if (!player1Id || !player2Id) {
      return res.status(400).json({ success: false, error: 'player1Id and player2Id are required' });
    }

    const matchId = metadata?.matchId;
    if (matchId) {
      const existingSession = await prisma.gameSession.findFirst({
        where: {
          metadata: {
            path: ['matchId'],
            equals: matchId
          }
        },
        orderBy: { createdAt: 'desc' }
      });

      if (existingSession) {
        const isSamePair =
          (existingSession.player1Id === player1Id && existingSession.player2Id === player2Id) ||
          (existingSession.player1Id === player2Id && existingSession.player2Id === player1Id);

        if (!isSamePair) {
          logger.warn(
            {
              matchId,
              existingSessionId: existingSession.sessionId,
              player1Id,
              player2Id,
              existingPlayer1Id: existingSession.player1Id,
              existingPlayer2Id: existingSession.player2Id
            },
            '[game-service] Match already has a session with different players'
          );
          return res.status(409).json({
            success: false,
            error: 'Match already has a game session with different players'
          });
        }

        const existingMetadata = existingSession.metadata || {};
        const durationSeconds =
          Number(existingMetadata?.maxDurationSeconds || existingMetadata?.matchDurationSeconds) ||
          Number(metadata?.maxDurationSeconds || metadata?.matchDurationSeconds) ||
          300;
        const startTime = existingSession.startedAt || existingSession.createdAt || new Date();

        logger.info(
          { matchId, sessionId: existingSession.sessionId },
          '[game-service] Reusing existing game session for match'
        );

        return res.status(200).json({
          success: true,
          data: {
            session: existingSession,
            sessionId: existingSession.sessionId,
            reused: true,
            matchTiming: {
              startTime,
              duration: durationSeconds,
              endTime: new Date(startTime.getTime() + durationSeconds * 1000)
            }
          }
        });
      }
    }

    // Detect AI game automatically
    const AI_PLAYER_ID = process.env.AI_PLAYER_ID || '04a942ce-af5f-4bde-9068-b9e2ee295fbf';
    const isAiGame = player1Id === AI_PLAYER_ID || player2Id === AI_PLAYER_ID;
    
    // Enhanced metadata handling for realtime sessions
    const enhancedMetadata = {
      ...metadata,
      sessionCreated: new Date().toISOString(),
      matchDurationSeconds: metadata?.maxDurationSeconds || 300,
      realTimeEnabled: true,
      // Auto-detect AI games
      gameType: isAiGame ? 'with_ai' : (metadata?.gameType || 'pvp'),
      aiPlayerId: isAiGame ? AI_PLAYER_ID : metadata?.aiPlayerId,
      aiDifficulty: isAiGame ? (metadata?.aiDifficulty || metadata?.ai || 5) : metadata?.aiDifficulty
    };

    // Use match start time if available, otherwise use current time
    const sessionStartTime = metadata?.startTime ? new Date(metadata.startTime) : new Date();

    const session = await prisma.gameSession.create({
      data: {
        tableId,
        player1Id,
        player2Id,
        metadata: enhancedMetadata,
        status: 'active',
        startedAt: sessionStartTime, // Use proper timing
      },
    });

    logger.info({ 
      sessionId: session.sessionId, 
      matchId: metadata?.matchId,
      startTime: sessionStartTime,
      duration: metadata?.maxDurationSeconds || 300
    }, '[game-service] Enhanced game session created for realtime play');
    
    res.status(201).json({ 
      success: true, 
      data: { 
        session,
        sessionId: session.sessionId,
        matchTiming: {
          startTime: sessionStartTime,
          duration: metadata?.maxDurationSeconds || 300,
          endTime: new Date(sessionStartTime.getTime() + (metadata?.maxDurationSeconds || 300) * 1000)
        }
      }
    });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to create session');
    res.status(500).json({ success: false, error: 'Failed to create game session' });
  }
};

exports.getSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await prisma.gameSession.findUnique({
      where: { sessionId },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true, data: session });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to get session');
    res.status(500).json({ success: false, error: 'Failed to get game session' });
  }
};

exports.listSessions = async (req, res) => {
  try {
    const { limit = 50, status } = req.query;

    const where = {};
    if (status) {
      where.status = status;
    }

    const sessions = await prisma.gameSession.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      take: Number(limit),
    });
    res.json({ success: true, data: sessions });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to list sessions');
    res.status(500).json({ success: false, error: 'Failed to list sessions' });
  }
};

exports.completeSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { result, metadata } = req.body;

    const session = await prisma.gameSession.findUnique({
      where: { sessionId },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const mergedMetadata = {
      ...safeParseMetadata(session.metadata),
      ...safeParseMetadata(metadata)
    };

    const updated = await prisma.gameSession.update({
      where: { sessionId },
      data: {
        status: 'completed',
        result: result || session.result,
        metadata: mergedMetadata,
        endedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Try to enqueue cleanup job for this session, but don't fail if Redis is unavailable
    try {
      const queue = getCleanupQueue();
      const job = await queue.add(
        'cleanup-game-session',
        { sessionId: updated.sessionId },
        { ...defaultJobOptions }
      );
      logger.info({ sessionId: updated.sessionId, jobId: job.id }, '[game-service] Session completed and cleanup job enqueued');
    } catch (redisError) {
      logger.warn({ sessionId: updated.sessionId, err: redisError }, '[game-service] Could not enqueue cleanup job (Redis unavailable), session completed anyway');
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to complete session');
    res.status(500).json({ success: false, error: 'Failed to complete game session' });
  }
};

exports.cancelSession = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await prisma.gameSession.findUnique({
      where: { sessionId },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const updated = await prisma.gameSession.update({
      where: { sessionId },
      data: {
        status: 'cancelled',
        endedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    logger.info({ sessionId: updated.sessionId }, '[game-service] Session cancelled');
    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to cancel session');
    res.status(500).json({ success: false, error: 'Failed to cancel game session' });
  }
};
