const express = require('express');
const { EarningsService } = require('../services/EarningsService');
const { PayoutService } = require('../services/PayoutService');
const { DailyEarningsJob } = require('../jobs/DailyEarningsJob');
const { RevenueAggregator } = require('../services/RevenueAggregator');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

// Initialize services
const earningsService = new EarningsService();
const payoutService = new PayoutService();
const revenueAggregator = new RevenueAggregator();
const dailyJob = new DailyEarningsJob();

/**
 * Admin Payments Controller - Manages agent earnings and payouts
 * 
 * Provides admin interface for:
 * - Viewing club revenue and agent earnings
 * - Computing and finalizing earnings
 * - Creating and managing payouts
 * - Configuring payout settings
 */

// Middleware to verify admin access
const requireAdminAccess = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    const userRole = String(req.user?.role || '').toLowerCase();
    const allowedRoles = new Set([
      'admin',
      'super_admin',
      'superuser',
      'superadmin',
      'manager',
      'director',
      'staff',
      'club_manager'
    ]);

    if (!userId || !allowedRoles.has(userRole)) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    next();
  } catch (error) {
    logger.error({ err: error }, '[AdminPaymentsController] Admin access check failed');
    res.status(500).json({
      success: false,
      error: 'Access verification failed'
    });
  }
};

/**
 * GET /api/admin/payments/clubs/:clubId/revenue
 * Get club revenue summary for date range
 */
router.get('/clubs/:clubId/revenue', requireAdminAccess, async (req, res) => {
  try {
    const { clubId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Start date and end date required'
      });
    }

    const revenueSummary = await revenueAggregator.getRevenueSummary(clubId, startDate, endDate);
    
    // Get detailed daily revenue
    const dailyRevenue = await prisma.clubRevenueDaily.findMany({
      where: {
        clubId,
        revenueDate: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: {
        revenueDate: 'asc'
      }
    });

    res.json({
      success: true,
      data: {
        summary: revenueSummary,
        dailyRevenue
      }
    });

  } catch (error) {
    logger.error({ err: error, clubId: req.params.clubId }, '[AdminPaymentsController] Failed to get club revenue');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve club revenue'
    });
  }
});

/**
 * GET /api/admin/payments/clubs/:clubId/earnings
 * Get agent earnings summary for date range
 */
router.get('/clubs/:clubId/earnings', requireAdminAccess, async (req, res) => {
  try {
    const { clubId } = req.params;
    const { startDate, endDate, status } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Start date and end date required'
      });
    }

    // Build where clause
    const whereClause = {
      clubId,
      earningsDate: {
        gte: startDate,
        lte: endDate
      }
    };

    if (status) {
      whereClause.status = status;
    }

    // Get earnings summary
    const earningsSummary = await earningsService.getEarningsSummary(clubId, startDate, endDate);
    
    // Get detailed earnings with agent info
    const detailedEarnings = await prisma.agentEarningsDaily.findMany({
      where: whereClause,
      orderBy: [
        { earningsDate: 'desc' },
        { totalAmount: 'desc' }
      ]
    });

    // Group by agent for summary
    const agentSummaries = {};
    detailedEarnings.forEach(earning => {
      if (!agentSummaries[earning.agentId]) {
        agentSummaries[earning.agentId] = {
          agentId: earning.agentId,
          totalEarnings: 0,
          totalMatches: 0,
          averageUptime: 0,
          daysWorked: 0,
          pendingAmount: 0,
          paidAmount: 0
        };
      }

      const agent = agentSummaries[earning.agentId];
      agent.totalEarnings += parseFloat(earning.totalAmount);
      agent.totalMatches += earning.matchesCompleted;
      agent.daysWorked++;
      
      if (earning.status === 'FINALIZED') {
        agent.pendingAmount += parseFloat(earning.totalAmount);
      } else if (earning.status === 'PAID') {
        agent.paidAmount += parseFloat(earning.totalAmount);
      }
    });

    // Calculate average uptime
    Object.values(agentSummaries).forEach(agent => {
      const agentEarnings = detailedEarnings.filter(e => e.agentId === agent.agentId);
      if (agentEarnings.length > 0) {
        agent.averageUptime = agentEarnings.reduce((sum, e) => sum + parseFloat(e.uptimePercentage), 0) / agentEarnings.length;
      }
    });

    res.json({
      success: true,
      data: {
        summary: earningsSummary,
        agentSummaries: Object.values(agentSummaries),
        detailedEarnings
      }
    });

  } catch (error) {
    logger.error({ err: error, clubId: req.params.clubId }, '[AdminPaymentsController] Failed to get club earnings');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve club earnings'
    });
  }
});

/**
 * POST /api/admin/payments/clubs/:clubId/earnings/compute
 * Compute earnings for a specific date
 */
router.post('/clubs/:clubId/earnings/compute', requireAdminAccess, async (req, res) => {
  try {
    const { clubId } = req.params;
    const { date } = req.body;
    const userId = req.user.userId;

    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'Date required'
      });
    }

    const result = await earningsService.computeDailyEarnings(clubId, date, userId);

    res.json({
      success: true,
      data: result,
      message: 'Earnings computed successfully'
    });

  } catch (error) {
    logger.error({ err: error, clubId: req.params.clubId }, '[AdminPaymentsController] Failed to compute earnings');
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to compute earnings'
    });
  }
});

/**
 * POST /api/admin/payments/clubs/:clubId/earnings/finalize
 * Finalize earnings for a specific date
 */
router.post('/clubs/:clubId/earnings/finalize', requireAdminAccess, async (req, res) => {
  try {
    const { clubId } = req.params;
    const { date } = req.body;
    const userId = req.user.userId;

    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'Date required'
      });
    }

    const result = await earningsService.finalizeEarnings(clubId, date, userId);

    res.json({
      success: true,
      data: result,
      message: 'Earnings finalized successfully'
    });

  } catch (error) {
    logger.error({ err: error, clubId: req.params.clubId }, '[AdminPaymentsController] Failed to finalize earnings');
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to finalize earnings'
    });
  }
});

/**
 * POST /api/admin/payments/clubs/:clubId/payouts/create
 * Create payout for agent
 */
router.post('/clubs/:clubId/payouts/create', requireAdminAccess, async (req, res) => {
  try {
    const { clubId } = req.params;
    const { agentId, periodStart, periodEnd, method, recipientDetails, reference } = req.body;
    const userId = req.user.userId;

    if (!agentId || !periodStart || !periodEnd) {
      return res.status(400).json({
        success: false,
        error: 'Agent ID, period start, and period end required'
      });
    }

    const payoutData = {
      method: method || 'WALLET',
      recipientDetails: recipientDetails || {},
      reference
    };

    const payout = await payoutService.createPayout(
      clubId,
      agentId,
      periodStart,
      periodEnd,
      payoutData,
      userId
    );

    res.json({
      success: true,
      data: payout,
      message: 'Payout created successfully'
    });

  } catch (error) {
    logger.error({ err: error, clubId: req.params.clubId }, '[AdminPaymentsController] Failed to create payout');
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create payout'
    });
  }
});

/**
 * GET /api/admin/payments/clubs/:clubId/payouts
 * Get payout transactions for club
 */
router.get('/clubs/:clubId/payouts', requireAdminAccess, async (req, res) => {
  try {
    const { clubId } = req.params;
    const { startDate, endDate, status, agentId } = req.query;

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const payoutsSummary = await payoutService.getClubPayouts(clubId, start, end);

    // Filter by specific criteria if provided
    let filteredPayouts = payoutsSummary.payouts;

    if (status) {
      filteredPayouts = filteredPayouts.filter(p => p.status === status);
    }

    if (agentId) {
      filteredPayouts = filteredPayouts.filter(p => p.agentId === agentId);
    }

    res.json({
      success: true,
      data: {
        ...payoutsSummary,
        payouts: filteredPayouts
      }
    });

  } catch (error) {
    logger.error({ err: error, clubId: req.params.clubId }, '[AdminPaymentsController] Failed to get club payouts');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve payouts'
    });
  }
});

/**
 * POST /api/admin/payments/payouts/:transactionId/retry
 * Retry failed payout
 */
router.post('/payouts/:transactionId/retry', requireAdminAccess, async (req, res) => {
  try {
    const { transactionId } = req.params;
    const userId = req.user.userId;

    const payout = await payoutService.retryPayout(transactionId, userId);

    res.json({
      success: true,
      data: payout,
      message: 'Payout retry initiated'
    });

  } catch (error) {
    logger.error({ err: error, transactionId: req.params.transactionId }, '[AdminPaymentsController] Failed to retry payout');
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to retry payout'
    });
  }
});

/**
 * GET /api/admin/payments/clubs/:clubId/config
 * Get club payout configuration
 */
router.get('/clubs/:clubId/config', requireAdminAccess, async (req, res) => {
  try {
    const { clubId } = req.params;

    const config = await prisma.clubPayoutConfig.findUnique({
      where: { clubId }
    });

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Payout configuration not found'
      });
    }

    res.json({
      success: true,
      data: config
    });

  } catch (error) {
    logger.error({ err: error, clubId: req.params.clubId }, '[AdminPaymentsController] Failed to get payout config');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve payout configuration'
    });
  }
});

/**
 * PUT /api/admin/payments/clubs/:clubId/config
 * Update club payout configuration
 */
router.put('/clubs/:clubId/config', requireAdminAccess, async (req, res) => {
  try {
    const { clubId } = req.params;
    const userId = req.user.userId;
    const configData = req.body;

    // Validate required fields
    const allowedFields = [
      'basePayAmount', 'agentSharePercent', 'weightByMatches', 'weightByUptime',
      'matchWeightPercent', 'uptimeWeightPercent', 'uptimeBonusEnabled',
      'uptimeBonusThreshold', 'uptimeBonusAmount', 'attendanceBonusEnabled',
      'attendanceBonusAmount', 'qualityBonusEnabled', 'qualityBonusAmount',
      'payoutFrequency', 'autoPayoutEnabled', 'minPayoutAmount'
    ];

    const updateData = {};
    Object.keys(configData).forEach(key => {
      if (allowedFields.includes(key)) {
        updateData[key] = configData[key];
      }
    });

    updateData.updatedBy = userId;

    const config = await prisma.clubPayoutConfig.upsert({
      where: { clubId },
      update: updateData,
      create: {
        clubId,
        ...updateData
      }
    });

    res.json({
      success: true,
      data: config,
      message: 'Payout configuration updated'
    });

  } catch (error) {
    logger.error({ err: error, clubId: req.params.clubId }, '[AdminPaymentsController] Failed to update payout config');
    res.status(500).json({
      success: false,
      error: 'Failed to update payout configuration'
    });
  }
});

/**
 * POST /api/admin/payments/jobs/run
 * Manually trigger daily earnings job
 */
router.post('/jobs/run', requireAdminAccess, async (req, res) => {
  try {
    const { date } = req.body;
    const userId = req.user.userId;

    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'Date required'
      });
    }

    const result = await dailyJob.runManualComputation(date, userId);

    res.json({
      success: true,
      data: result,
      message: 'Daily earnings job completed'
    });

  } catch (error) {
    logger.error({ err: error }, '[AdminPaymentsController] Failed to run daily job');
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to run daily earnings job'
    });
  }
});

/**
 * GET /api/admin/payments/jobs/status
 * Get daily job status
 */
router.get('/jobs/status', requireAdminAccess, async (req, res) => {
  try {
    const status = dailyJob.getStatus();
    const lastExecution = await dailyJob.getLastExecutionTime();

    res.json({
      success: true,
      data: {
        ...status,
        lastExecution
      }
    });

  } catch (error) {
    logger.error({ err: error }, '[AdminPaymentsController] Failed to get job status');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve job status'
    });
  }
});

/**
 * GET /api/admin/payments/reports/payout
 * Generate payout report
 */
router.get('/reports/payout', requireAdminAccess, async (req, res) => {
  try {
    const { clubId, startDate, endDate } = req.query;

    if (!clubId || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Club ID, start date, and end date required'
      });
    }

    const report = await payoutService.generatePayoutReport(clubId, startDate, endDate);

    res.json({
      success: true,
      data: report
    });

  } catch (error) {
    logger.error({ err: error }, '[AdminPaymentsController] Failed to generate payout report');
    res.status(500).json({
      success: false,
      error: 'Failed to generate payout report'
    });
  }
});

module.exports = router;
