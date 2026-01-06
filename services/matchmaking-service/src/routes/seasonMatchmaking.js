const express = require('express');
const SeasonMatchmakingController = require('../controllers/seasonMatchmakingController');

const router = express.Router();

// Season matchmaking routes (using existing auth middleware)
router.post('/seasons/:seasonId/queue/join', SeasonMatchmakingController.joinSeasonQueue);
router.post('/seasons/:seasonId/queue/leave', SeasonMatchmakingController.leaveQueue);
router.get('/seasons/:seasonId/queue/status', SeasonMatchmakingController.getQueueStatus);

// Player matches in season
router.get('/seasons/:seasonId/players/:playerId/matches', SeasonMatchmakingController.getPlayerMatches);

// Match management
router.post('/matches/:matchId/start', SeasonMatchmakingController.startMatch);

module.exports = router;