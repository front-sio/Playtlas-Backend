const express = require('express');
const SeasonMatchmakingController = require('../controllers/seasonMatchmakingController');
const { authMiddleware } = require('../../../../shared/middlewares/authMiddleware');

const router = express.Router();

const requireAnyRole = (roles = []) => (req, res, next) => {
  const userRole = String(req.user?.role || '').toLowerCase();
  if (!userRole) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const allowed = new Set(roles.map((role) => String(role).toLowerCase()));
  if (!allowed.has(userRole)) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  next();
};

// Season matchmaking routes (using existing auth middleware)
router.post('/seasons/:seasonId/queue/join', SeasonMatchmakingController.joinSeasonQueue);
router.post('/seasons/:seasonId/queue/leave', SeasonMatchmakingController.leaveQueue);
router.get('/seasons/:seasonId/queue/status', SeasonMatchmakingController.getQueueStatus);

// Player matches in season
router.get('/seasons/:seasonId/players/:playerId/matches', SeasonMatchmakingController.getPlayerMatches);

// Match management
router.post(
  '/matches/:matchId/start',
  authMiddleware,
  requireAnyRole(['agent', 'service', 'admin', 'super_admin', 'superuser', 'superadmin']),
  SeasonMatchmakingController.startMatch
);

// AI routes removed

module.exports = router;
