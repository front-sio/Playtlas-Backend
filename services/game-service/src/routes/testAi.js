const express = require('express');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');

const router = express.Router();

// Test endpoint to check AI functionality
router.get('/test-ai/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await prisma.gameSession.findUnique({
      where: { sessionId }
    });
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const AI_PLAYER_ID = process.env.AI_PLAYER_ID || '04a942ce-af5f-4bde-9068-b9e2ee295fbf';
    
    const analysis = {
      sessionId,
      player1Id: session.player1Id,
      player2Id: session.player2Id,
      aiPlayerId: AI_PLAYER_ID,
      isPlayer1AI: session.player1Id === AI_PLAYER_ID,
      isPlayer2AI: session.player2Id === AI_PLAYER_ID,
      aiSide: session.player1Id === AI_PLAYER_ID ? 'p1' : (session.player2Id === AI_PLAYER_ID ? 'p2' : null),
      status: session.status,
      player1Ready: session.player1Ready,
      player2Ready: session.player2Ready,
      player1Connected: session.player1Connected,
      player2Connected: session.player2Connected,
      metadata: typeof session.metadata === 'string' ? JSON.parse(session.metadata) : session.metadata,
      gameState: session.gameState ? (typeof session.gameState === 'string' ? JSON.parse(session.gameState) : session.gameState) : null
    };
    
    logger.info({ analysis }, '[test] AI session analysis');
    
    res.json({ success: true, analysis });
  } catch (error) {
    logger.error({ err: error }, '[test] AI test error');
    res.status(500).json({ success: false, error: error.message });
  }
});

// Force AI turn for testing
router.post('/force-ai-turn/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await prisma.gameSession.findUnique({
      where: { sessionId }
    });
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Import the functions we need (this is a bit of a hack for testing)
    const { getOrCreateEngine, scheduleAiTurn } = require('../controllers/gameSocketController');
    const io = req.app.get('io');
    
    if (!io) {
      return res.status(500).json({ error: 'Socket.IO not available' });
    }
    
    const engine = await getOrCreateEngine(session);
    await scheduleAiTurn({ io, session, engine });
    
    res.json({ success: true, message: 'AI turn scheduled' });
  } catch (error) {
    logger.error({ err: error }, '[test] Force AI turn error');
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;