// backend/services/game-service/src/routes/authoritativeGameRoutes.js
/**
 * Routes for authoritative server-side game execution
 */

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authoritativeGameController');
const { authenticateToken } = require('../middleware/auth'); // Assuming auth middleware exists

// Initialize a new game
router.post('/init', authenticateToken, authController.initGame);

// Execute a shot
router.post('/:matchId/shot', authenticateToken, authController.executeShot);

// Execute AI turn
router.post('/:matchId/ai-turn', authController.executeAiTurn);

// Get current game state
router.get('/:matchId/state', authController.getGameState);

// Get stats (admin only - add admin middleware if needed)
router.get('/stats', authController.getStats);

module.exports = router;
