const express = require('express');
const router = express.Router();

const gameController = require('../controllers/gameController');

// Game session routes - only multiplayer now (single device club-based)
router.post('/sessions', gameController.createSession);
router.post('/sessions/multiplayer', gameController.createSession);
router.get('/sessions', gameController.listSessions);
router.get('/sessions/:sessionId', gameController.getSession);
router.post('/sessions/:sessionId/metadata', gameController.updateSessionMetadata);
router.post('/sessions/:sessionId/start', gameController.startSession);
router.post('/sessions/:sessionId/complete', gameController.completeSession);
router.post('/sessions/:sessionId/cancel', gameController.cancelSession);

// Club-based match result submission
router.post('/sessions/:sessionId/submit-result', gameController.submitMatchResult);

module.exports = router;
