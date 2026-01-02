const express = require('express');
const router = express.Router();
const revenueController = require('../controllers/revenueController');
const authenticate = require('../middlewares/auth');

// Aggregation (admin only)
router.post('/aggregate', authenticate, revenueController.aggregateRevenue);

// Platform Revenue
router.get('/platform', authenticate, revenueController.getPlatformRevenue);
router.get('/dashboard', authenticate, revenueController.getDashboardStats);

// Revenue by Provider
router.get('/provider', authenticate, revenueController.getRevenueByProvider);

// Agent Revenue
router.get('/agent', authenticate, revenueController.getAgentRevenue);

// Player Revenue
router.get('/player', authenticate, revenueController.getPlayerRevenue);

// Alerts
router.get('/alerts', authenticate, revenueController.getRevenueAlerts);
router.post('/alerts', authenticate, revenueController.createRevenueAlert);
router.put('/alerts/:alertId/resolve', authenticate, revenueController.resolveRevenueAlert);

module.exports = router;
