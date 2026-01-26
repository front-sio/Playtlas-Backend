// backend/services/game-service/src/routes/authoritativeGameRoutes.js
/**
 * Routes for club-based single-device game execution
 */

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authoritativeGameController');
const { authenticateToken } = require('../middleware/auth'); // Assuming auth middleware exists

// Initialize a new club-based game
router.post('/init', authenticateToken, authController.initGame);

// Submit match result from club device
router.post('/:matchId/submit-result', authenticateToken, authController.submitMatchResult);

// Get current game state
router.get('/:matchId/state', authController.getGameState);

// Get stats (admin only - add admin middleware if needed)
router.get('/stats', authController.getStats);

module.exports = router;
