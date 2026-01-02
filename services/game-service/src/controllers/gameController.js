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

exports.createSession = async (req, res) => {
  try {
    const { tableId, player1Id, player2Id, metadata } = req.body;

    if (!player1Id || !player2Id) {
      return res.status(400).json({ success: false, error: 'player1Id and player2Id are required' });
    }

    const session = await prisma.gameSession.create({
      data: {
        tableId,
        player1Id,
        player2Id,
        metadata,
        status: 'active',
        startedAt: new Date(),
      },
    });

    logger.info({ sessionId: session.sessionId }, '[game-service] Game session created');
    res.status(201).json({ success: true, data: session });
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

    const updated = await prisma.gameSession.update({
      where: { sessionId },
      data: {
        status: 'completed',
        result: result || session.result,
        metadata: metadata || session.metadata,
        endedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Enqueue cleanup job for this session
    const queue = getCleanupQueue();
    const job = await queue.add(
      'cleanup-game-session',
      { sessionId: updated.sessionId },
      { ...defaultJobOptions }
    );

    logger.info({ sessionId: updated.sessionId, jobId: job.id }, '[game-service] Session completed and cleanup job enqueued');

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
