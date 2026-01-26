const express = require('express');
const router = express.Router();
const tournamentController = require('../controllers/tournamentController');
const clubController = require('../controllers/clubController');
const authMiddleware = require('../middlewares/authMiddleware');

// Clubs
router.post('/clubs', authMiddleware, clubController.createClub);
router.get('/clubs', authMiddleware, clubController.getClubs);
router.get('/clubs/:clubId', authMiddleware, clubController.getClub);
router.put('/clubs/:clubId', authMiddleware, clubController.updateClub);
router.delete('/clubs/:clubId', authMiddleware, clubController.deleteClub);

router.post('/', authMiddleware, tournamentController.createTournament);
router.get('/', tournamentController.getTournaments);
router.get('/stats', authMiddleware, tournamentController.getTournamentStats);
router.get('/players/:playerId/seasons', authMiddleware, tournamentController.getPlayerSeasons);

router.get('/:tournamentId', tournamentController.getTournament);
router.post('/:tournamentId/cancel', authMiddleware, tournamentController.cancelTournament);
router.post('/:tournamentId/stop', authMiddleware, tournamentController.stopTournament);
router.post('/:tournamentId/resume', authMiddleware, tournamentController.resumeTournament);
// Backwards compatible: joins the latest upcoming season (preferred API is /seasons/:seasonId/join)
router.post('/:tournamentId/join', authMiddleware, tournamentController.joinTournament);
router.post('/:tournamentId/start', authMiddleware, tournamentController.startTournament);

// Seasons
router.get('/:tournamentId/seasons', authMiddleware, tournamentController.getTournamentSeasons);
router.get('/seasons/:seasonId', authMiddleware, tournamentController.getSeason);
router.post('/seasons/:seasonId/join', authMiddleware, tournamentController.joinSeason);

// Admin endpoints
router.put('/:tournamentId', authMiddleware, tournamentController.updateTournament);
router.delete('/:tournamentId', authMiddleware, tournamentController.deleteTournament);
router.post('/admin/seasons/repair', authMiddleware, tournamentController.repairSeasonFixtures);

module.exports = router;
