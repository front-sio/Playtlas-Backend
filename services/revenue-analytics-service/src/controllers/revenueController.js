const revenueAggregationService = require('../services/revenueAggregationService');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const axios = require('axios');

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3007';
const AI_PLAYER_ID = process.env.AI_PLAYER_ID || null;
const AI_WALLET_OWNER_ID = process.env.AI_WALLET_OWNER_ID || AI_PLAYER_ID;
const AI_WALLET_TYPE = process.env.AI_WALLET_TYPE || 'ai';
const SERVICE_JWT_TOKEN = process.env.SERVICE_JWT_TOKEN || null;

const ADMIN_ROLES = new Set([
  'admin',
  'super_admin',
  'superuser',
  'superadmin',
  'finance_manager',
  'manager',
  'director',
  'staff'
]);

const ensureAdmin = (req, res) => {
  if (!ADMIN_ROLES.has(req.user?.role)) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return false;
  }
  return true;
};

const getServiceHeaders = (req) => {
  if (req?.headers?.authorization) {
    return { Authorization: req.headers.authorization };
  }
  if (SERVICE_JWT_TOKEN) {
    return { Authorization: `Bearer ${SERVICE_JWT_TOKEN}` };
  }
  return {};
};

const fetchAiWallet = async (headers) => {
  if (!AI_WALLET_OWNER_ID) return null;

  try {
    const response = await axios.get(
      `${WALLET_SERVICE_URL}/owner/${encodeURIComponent(AI_WALLET_OWNER_ID)}?type=${encodeURIComponent(AI_WALLET_TYPE)}`,
      { headers }
    );
    return response.data?.data || response.data;
  } catch (error) {
    if (error.response?.status !== 404) {
      throw error;
    }
  }

  try {
    const response = await axios.get(
      `${WALLET_SERVICE_URL}/owner/${encodeURIComponent(AI_WALLET_OWNER_ID)}?type=player`,
      { headers }
    );
    return response.data?.data || response.data;
  } catch (error) {
    if (error.response?.status !== 404) {
      throw error;
    }
  }

  return null;
};

/**
 * Aggregate revenue for a specific date (admin only)
 */
exports.aggregateRevenue = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { date, type = 'all' } = req.body;
    
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date is required' });
    }

    const aggregationDate = new Date(date);
    const results = {};

    if (type === 'all' || type === 'platform') {
      results.platform = await revenueAggregationService.aggregatePlatformRevenue(aggregationDate);
    }

    if (type === 'all' || type === 'provider') {
      results.provider = await revenueAggregationService.aggregateRevenueByProvider(aggregationDate);
    }

    if (type === 'all' || type === 'agent') {
      results.agent = await revenueAggregationService.aggregateAgentRevenue(aggregationDate);
    }

    if (type === 'all' || type === 'player') {
      results.player = await revenueAggregationService.aggregatePlayerRevenue(aggregationDate);
    }

    res.json({ success: true, data: results });
  } catch (error) {
    logger.error('Aggregate revenue error:', error);
    res.status(500).json({ success: false, error: 'Failed to aggregate revenue' });
  }
};

/**
 * Get Platform Revenue Summary
 */
exports.getPlatformRevenue = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Start date and end date are required' });
    }

    const summary = await revenueAggregationService.getPlatformRevenueSummary(startDate, endDate);

    res.json({ success: true, data: summary });
  } catch (error) {
    logger.error('Get platform revenue error:', error);
    res.status(500).json({ success: false, error: 'Failed to get platform revenue' });
  }
};

/**
 * Get Revenue by Provider
 */
exports.getRevenueByProvider = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { startDate, endDate, provider } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Start date and end date are required' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    const where = {
      date: { gte: start, lte: end }
    };

    if (provider) {
      where.provider = provider;
    }

    const revenues = await prisma.revenueByProvider.findMany({
      where,
      orderBy: { date: 'asc' }
    });

    // Aggregate totals
    const summary = {
      totalRevenue: 0,
      totalDepositRevenue: 0,
      totalWithdrawalRevenue: 0,
      totalTransactionFees: 0,
      byProvider: {},
      data: revenues
    };

    for (const r of revenues) {
      summary.totalRevenue += r.totalRevenue;
      summary.totalDepositRevenue += r.depositRevenue;
      summary.totalWithdrawalRevenue += r.withdrawalRevenue;
      summary.totalTransactionFees += r.transactionFees;

      if (!summary.byProvider[r.provider]) {
        summary.byProvider[r.provider] = {
          provider: r.provider,
          totalRevenue: 0,
          depositRevenue: 0,
          withdrawalRevenue: 0,
          transactionFees: 0
        };
      }

      summary.byProvider[r.provider].totalRevenue += r.totalRevenue;
      summary.byProvider[r.provider].depositRevenue += r.depositRevenue;
      summary.byProvider[r.provider].withdrawalRevenue += r.withdrawalRevenue;
      summary.byProvider[r.provider].transactionFees += r.transactionFees;
    }

    res.json({ success: true, data: summary });
  } catch (error) {
    logger.error('Get revenue by provider error:', error);
    res.status(500).json({ success: false, error: 'Failed to get revenue by provider' });
  }
};

/**
 * Get Agent Revenue Summary
 */
exports.getAgentRevenue = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { startDate, endDate, agentId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Start date and end date are required' });
    }

    const summary = await revenueAggregationService.getAgentRevenueSummary(
      startDate,
      endDate,
      agentId
    );

    res.json({ success: true, data: summary });
  } catch (error) {
    logger.error('Get agent revenue error:', error);
    res.status(500).json({ success: false, error: 'Failed to get agent revenue' });
  }
};

/**
 * Get Player Revenue Summary
 */
exports.getPlayerRevenue = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { startDate, endDate, playerId, limit = 100, offset = 0 } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Start date and end date are required' });
    }

    const summary = await revenueAggregationService.getPlayerRevenueSummary(
      startDate,
      endDate,
      playerId,
      parseInt(limit),
      parseInt(offset)
    );

    res.json({ success: true, data: summary });
  } catch (error) {
    logger.error('Get player revenue error:', error);
    res.status(500).json({ success: false, error: 'Failed to get player revenue' });
  }
};

/**
 * Get Dashboard Stats (real-time overview)
 */
exports.getDashboardStats = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);

    // Get revenue for different time periods
    const [todayRevenue, yesterdayRevenue, weekRevenue, monthRevenue] = await Promise.all([
      prisma.platformRevenue.findFirst({
        where: { date: today, period: 'daily' }
      }),
      prisma.platformRevenue.findFirst({
        where: { date: yesterday, period: 'daily' }
      }),
      prisma.platformRevenue.findMany({
        where: {
          date: { gte: weekAgo, lte: today },
          period: 'daily'
        }
      }),
      prisma.platformRevenue.findMany({
        where: {
          date: { gte: monthAgo, lte: today },
          period: 'daily'
        }
      })
    ]);

    const todayTotal = todayRevenue?.totalRevenue || 0;
    const yesterdayTotal = yesterdayRevenue?.totalRevenue || 0;
    const weekTotal = weekRevenue.reduce((sum, r) => sum + r.totalRevenue, 0);
    const monthTotal = monthRevenue.reduce((sum, r) => sum + r.totalRevenue, 0);

    // Calculate growth rates
    const dailyGrowth = yesterdayTotal > 0 ? ((todayTotal - yesterdayTotal) / yesterdayTotal) * 100 : 0;
    const weeklyGrowth = weekTotal > 0 ? (todayTotal / weekTotal) * 100 : 0;
    const dailyAverage = monthTotal / monthRevenue.length || 0;

    // Get top agents and players
    const [topAgents, topPlayers] = await Promise.all([
      prisma.agentRevenue.groupBy({
        by: ['agentId', 'agentName'],
        _sum: { playerRevenue: true, commissionEarned: true },
        orderBy: { _sum: { playerRevenue: 'desc' } },
        take: 5
      }),
      prisma.playerRevenue.findMany({
        orderBy: { lifetimeValue: 'desc' },
        take: 5
      })
    ]);

    const headers = getServiceHeaders(req);
    const [platformWalletRes, systemWalletRes, aiWallet, agentWalletsRes] = await Promise.all([
      axios.get(`${WALLET_SERVICE_URL}/platform/wallet`, { headers }).catch(() => ({ data: {} })),
      axios.get(`${WALLET_SERVICE_URL}/system/wallet`, { headers }).catch(() => ({ data: {} })),
      fetchAiWallet(headers).catch(() => null),
      axios
        .get(`${WALLET_SERVICE_URL}/admin/wallets`, {
          headers,
          params: { type: 'agent', limit: 1000, offset: 0 }
        })
        .catch(() => ({ data: {} }))
    ]);

    const platformWalletData = platformWalletRes.data?.data || platformWalletRes.data || {};
    const systemWalletData = systemWalletRes.data?.data || systemWalletRes.data || {};
    const aiWalletData = aiWallet || {};
    const agentWallets = agentWalletsRes.data?.data || agentWalletsRes.data || [];

    const platformWalletBalance = Number(platformWalletData.balance || 0);
    const systemWalletBalance = Number(systemWalletData.balance || 0);
    const aiWalletBalance = Number(aiWalletData.balance || 0);
    const agentRevenue = Array.isArray(agentWallets)
      ? agentWallets.reduce((sum, wallet) => sum + Number(wallet.balance || 0), 0)
      : 0;

    res.json({
      success: true,
      data: {
        today: {
          revenue: todayTotal,
          tournamentFees: todayRevenue?.tournamentFees || 0,
          depositFees: todayRevenue?.depositFees || 0,
          withdrawalFees: todayRevenue?.withdrawalFees || 0,
          growth: dailyGrowth
        },
        yesterday: {
          revenue: yesterdayTotal
        },
        week: {
          revenue: weekTotal,
          dailyAverage: weekTotal / weekRevenue.length || 0
        },
        month: {
          revenue: monthTotal,
          dailyAverage
        },
        topAgents: topAgents.map(a => ({
          agentId: a.agentId,
          agentName: a.agentName,
          revenue: a._sum.playerRevenue,
          commission: a._sum.commissionEarned
        })),
        topPlayers: topPlayers.map(p => ({
          playerId: p.playerId,
          username: p.username,
          lifetimeValue: p.lifetimeValue,
          netProfit: p.netProfit
        })),
        realtime: {
          platformWalletBalance,
          systemWalletBalance,
          aiWalletBalance,
          agentRevenue
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Get dashboard stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get dashboard stats' });
  }
};

/**
 * Get Revenue Alerts
 */
exports.getRevenueAlerts = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { isResolved, alertType, limit = 50, offset = 0 } = req.query;

    const where = {};
    if (isResolved !== undefined) {
      where.isResolved = isResolved === 'true';
    }
    if (alertType) {
      where.alertType = alertType;
    }

    const [alerts, total] = await Promise.all([
      prisma.revenueAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset)
      }),
      prisma.revenueAlert.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        alerts,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    logger.error('Get revenue alerts error:', error);
    res.status(500).json({ success: false, error: 'Failed to get revenue alerts' });
  }
};

/**
 * Create Revenue Alert
 */
exports.createRevenueAlert = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { alertType, severity, title, description, metricName, thresholdValue } = req.body;

    if (!alertType || !title || !description || !metricName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: alertType, title, description, metricName' 
      });
    }

    const alert = await prisma.revenueAlert.create({
      data: {
        alertType,
        severity: severity || 'medium',
        title,
        description,
        metricName,
        thresholdValue,
        metadata: req.body.metadata || {}
      }
    });

    logger.info(`Revenue alert created: ${alert.id}`);
    res.status(201).json({ success: true, data: alert });
  } catch (error) {
    logger.error('Create revenue alert error:', error);
    res.status(500).json({ success: false, error: 'Failed to create revenue alert' });
  }
};

/**
 * Resolve Revenue Alert
 */
exports.resolveRevenueAlert = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { alertId } = req.params;
    const { notes } = req.body;

    const alert = await prisma.revenueAlert.update({
      where: { id: alertId },
      data: {
        isResolved: true,
        resolvedAt: new Date(),
        resolvedBy: req.user.userId,
        metadata: {
          ...(await prisma.revenueAlert.findUnique({ where: { id: alertId} })).metadata,
          resolutionNotes: notes
        }
      }
    });

    logger.info(`Revenue alert resolved: ${alertId}`);
    res.json({ success: true, data: alert });
  } catch (error) {
    logger.error('Resolve revenue alert error:', error);
    res.status(500).json({ success: false, error: 'Failed to resolve revenue alert' });
  }
};
