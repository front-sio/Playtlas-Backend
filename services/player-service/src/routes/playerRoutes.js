const express = require('express');
const router = express.Router();
const playerController = require('../controllers/playerController');

router.post('/', playerController.createOrUpdatePlayer);
router.get('/:playerId/stats', playerController.getPlayerStats);
router.post('/match-result', playerController.updateMatchResult);
router.get('/leaderboard', playerController.getLeaderboard);
router.post('/achievements', playerController.addAchievement);

module.exports = router;
