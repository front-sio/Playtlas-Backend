const express = require('express');
const router = express.Router();

const gameController = require('../controllers/gameController');
const testAi = require('./testAi');

// Game session routes
router.post('/sessions', gameController.createSession);
router.get('/sessions', gameController.listSessions);
router.get('/sessions/:sessionId', gameController.getSession);
router.post('/sessions/:sessionId/complete', gameController.completeSession);
router.post('/sessions/:sessionId/cancel', gameController.cancelSession);

// AI testing routes (only in development)
if (process.env.NODE_ENV !== 'production') {
  router.use('/ai', testAi);
}

module.exports = router;
