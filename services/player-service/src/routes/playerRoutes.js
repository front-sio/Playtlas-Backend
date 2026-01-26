const express = require('express');
const router = express.Router();
const playerController = require('../controllers/playerController');
const serviceAuth = require('../middlewares/serviceAuth');

router.post('/', serviceAuth, playerController.createOrUpdatePlayer);
router.get('/agent/:agentUserId/analytics', serviceAuth, playerController.getAgentAnalytics);
router.get('/:playerId/stats', playerController.getPlayerStats);
router.post('/match-result', serviceAuth, playerController.updateMatchResult);
router.get('/leaderboard', playerController.getLeaderboard);
router.post('/achievements', serviceAuth, playerController.addAchievement);

module.exports = router;
