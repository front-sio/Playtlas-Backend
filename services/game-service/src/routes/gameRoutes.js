const express = require('express');
const router = express.Router();

const gameController = require('../controllers/gameController');

// Game session routes
router.post('/sessions', gameController.createSession);
router.get('/sessions', gameController.listSessions);
router.get('/sessions/:sessionId', gameController.getSession);
router.post('/sessions/:sessionId/complete', gameController.completeSession);
router.post('/sessions/:sessionId/cancel', gameController.cancelSession);

module.exports = router;
