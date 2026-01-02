const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const ActivityLogger = require('../utils/activityLogger');
const { asyncHandler } = require('../middlewares/errorHandler');
const axios = require('axios');
const { sendTournamentCommand } = require('../kafka/tournamentCommandClient');
const { emitDashboardStats, emitUserStats, emitPaymentStats } = require('../utils/socketEmitter');

// Create separate Prisma client for game service database
const { PrismaClient: GamePrismaClient } = require('@prisma/client');
const gamePrisma = new GamePrismaClient({
  datasources: {
    db: {
      url: process.env.GAME_DATABASE_URL || 'postgresql://admin:adminpass@localhost:5433/game_db'
    }
  }
});

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3007';
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'http://localhost:3003';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3003';
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || 'http://localhost:3010';

const getAuthHeaders = (req) => {
  const authHeader = req.headers.authorization;
  return authHeader ? { Authorization: authHeader } : {};
};

const toDate = (value) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const buildTournamentReadModelData = (payload) => {
  const isDeleted = payload?.status === 'deleted' || payload?.isDeleted === true;
  return {
    name: payload?.name,
    description: payload?.description ?? null,
    entryFee: payload?.entryFee !== undefined ? Number(payload.entryFee) : undefined,
    maxPlayers: payload?.maxPlayers !== undefined ? Number(payload.maxPlayers) : undefined,
    currentPlayers: payload?.currentPlayers !== undefined ? Number(payload.currentPlayers) : undefined,
    status: payload?.status,
    stage: payload?.stage ?? null,
    competitionWalletId: payload?.competitionWalletId ?? null,
    startTime: toDate(payload?.startTime),
    endTime: toDate(payload?.endTime),
    seasonDuration: payload?.seasonDuration !== undefined ? Number(payload.seasonDuration) : undefined,
    updatedAt: toDate(payload?.updatedAt) || new Date(),
    lastEventAt: new Date(),
    isDeleted
  };
};

const syncTournamentReadModel = async (payload) => {
  if (!payload?.tournamentId) return;
  const updateData = buildTournamentReadModelData(payload);
  const createData = {
    tournamentId: payload.tournamentId,
    ...updateData,
    createdAt: toDate(payload.createdAt) || new Date()
  };

  await prisma.tournamentReadModel.upsert({
    where: { tournamentId: payload.tournamentId },
    update: updateData,
    create: createData
  });
};

const markTournamentDeleted = async (tournamentId) => {
  if (!tournamentId) return;
  await prisma.tournamentReadModel.updateMany({
    where: { tournamentId },
    data: {
      status: 'deleted',
      isDeleted: true,
      updatedAt: new Date(),
      lastEventAt: new Date()
    }
  });
};

// Admin User Management
exports.createAdmin = asyncHandler(async (req, res) => {
  const { userId, role, createdBy, permissions } = req.body;

  if (![
    'admin',
    'moderator',
    'finance_manager',
    'tournament_manager',
    'game_manager',
    'game_master',
    'support',
    'super_admin',
    'superuser',
    'superadmin'
  ].includes(role)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid role specified' 
    });
  }

  const admin = await prisma.adminUser.create({
    data: {
      userId,
      role,
      permissions: permissions || {},
      createdBy: createdBy || req.adminId
    }
  });

  await ActivityLogger.log(
    req.adminId,
    'create_admin',
    'admin_users',
    { resourceId: admin.adminId, role, userId }
  );

  logger.info(`Admin created: ${admin.adminId} with role ${role}`);
  res.status(201).json({ success: true, data: admin });
});

exports.getAdmins = asyncHandler(async (req, res) => {
  const { role, isActive, limit = 50, offset = 0 } = req.query;

  const where = {};
  if (role) where.role = role;
  if (isActive !== undefined) where.isActive = isActive === 'true';

  const admins = await prisma.adminUser.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parseInt(limit, 10),
    skip: parseInt(offset, 10)
  });

  res.json({ success: true, data: admins });
});

exports.updateAdmin = asyncHandler(async (req, res) => {
  const { adminId } = req.params;
  const { role, isActive, permissions } = req.body;

  const updateData = {};
  if (role) updateData.role = role;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (permissions) updateData.permissions = permissions;
  updateData.updatedAt = new Date();

  const existing = await prisma.adminUser.findUnique({ where: { adminId } });
  if (!existing) return res.status(404).json({ success: false, error: 'Admin not found' });

  const updated = await prisma.adminUser.update({
    where: { adminId },
    data: updateData
  });

  await ActivityLogger.log(
    req.adminId,
    'update_admin',
    'admin_users',
    { resourceId: adminId, changes: updateData }
  );

  logger.info(`Admin updated: ${adminId}`);
  res.json({ success: true, data: updated });
});

exports.deleteAdmin = asyncHandler(async (req, res) => {
  const { adminId } = req.params;

  await prisma.adminUser.update({
    where: { adminId },
    data: { isActive: false, updatedAt: new Date() }
  });

  await ActivityLogger.log(
    req.adminId,
    'deactivate_admin',
    'admin_users',
    { resourceId: adminId }
  );

  logger.info(`Admin deactivated: ${adminId}`);
  res.json({ success: true, message: 'Admin deactivated' });
});

// System Settings Management
exports.getSettings = asyncHandler(async (req, res) => {
  const { category, isPublic } = req.query;

  const where = {};
  if (category) where.category = category;
  if (isPublic !== undefined) where.isPublic = isPublic === 'true';

  const settings = await prisma.systemSetting.findMany({ where });

  res.json({ success: true, data: settings });
});

exports.updateSetting = asyncHandler(async (req, res) => {
  const { key, value, category, description, isPublic } = req.body;

  const result = await prisma.systemSetting.upsert({
    where: { key },
    update: {
      value,
      category,
      description,
      isPublic: isPublic !== undefined ? isPublic : undefined,
      updatedBy: req.adminId,
      updatedAt: new Date()
    },
    create: {
      key,
      value,
      category,
      description,
      isPublic: isPublic || false,
      updatedBy: req.adminId
    }
  });

  await ActivityLogger.log(
    req.adminId,
    'update_setting',
    'system_settings',
    { resourceId: result.settingId, key, value }
  );

  logger.info(`System setting updated: ${key}`);
  res.json({ success: true, data: result });
});

// Activity Logs
exports.getActivityLogs = asyncHandler(async (req, res) => {
  const { adminId, action, resource, status, startDate, endDate, limit = 100, offset = 0 } = req.query;

  const where = {};
  if (adminId) where.adminId = adminId;
  if (action) where.action = action;
  if (resource) where.resource = resource;
  if (status) where.status = status;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const logs = await prisma.activityLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: parseInt(limit, 10),
    skip: parseInt(offset, 10)
  });

  res.json({ success: true, data: logs });
});

// User Management (via Auth Service)
exports.getAllUsers = asyncHandler(async (req, res) => {
  const { role, limit = 50, offset = 0 } = req.query;

  const response = await axios.get(`${AUTH_SERVICE_URL}/users`, {
    params: { role, limit, offset },
    headers: getAuthHeaders(req)
  });

  await ActivityLogger.log(req.adminId, 'view_users', 'users', { count: response.data.data?.length });

  res.json(response.data);
});

exports.updateUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const updateData = req.body;

  const response = await axios.put(`${AUTH_SERVICE_URL}/users/${userId}`, updateData, {
    headers: getAuthHeaders(req)
  });

  await ActivityLogger.log(
    req.adminId,
    'update_user',
    'users',
    { resourceId: userId, changes: updateData }
  );

  res.json(response.data);
});

exports.suspendUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;

  const response = await axios.post(`${AUTH_SERVICE_URL}/users/${userId}/suspend`, { reason }, {
    headers: getAuthHeaders(req)
  });

  await ActivityLogger.log(
    req.adminId,
    'suspend_user',
    'users',
    { resourceId: userId, reason }
  );

  logger.info(`User suspended: ${userId}`);
  res.json(response.data);
});

// Financial Reports
exports.generateFinancialReport = asyncHandler(async (req, res) => {
  const { startDate, endDate, format = 'json' } = req.body;

  try {
    const walletResponse = await axios.get(`${WALLET_SERVICE_URL}/report`, {
      params: { startDate, endDate },
      headers: getAuthHeaders(req)
    });
    const walletData = walletResponse.data?.data || walletResponse.data;

    const report = await prisma.report.create({
      data: {
        reportType: 'financial',
        generatedBy: req.adminId,
        parameters: { startDate, endDate },
        data: walletData,
        format,
        status: 'completed'
      }
    });

    await ActivityLogger.log(
      req.adminId,
      'generate_report',
      'reports',
      { resourceId: report.reportId, type: 'financial' }
    );

    logger.info(`Financial report generated: ${report.reportId}`);
    res.json({ success: true, data: report });
  } catch (error) {
    await prisma.report.create({
      data: {
        reportType: 'financial',
        generatedBy: req.adminId,
        parameters: { startDate, endDate },
        format,
        status: 'failed'
      }
    });

    throw error;
  }
});

// Tournament Management
exports.getTournamentStats = asyncHandler(async (req, res) => {
  try {
    const result = await sendTournamentCommand({
      action: 'STATS',
      data: {},
      actor: { userId: req.adminId, role: req.userRole }
    });

    await ActivityLogger.log(req.adminId, 'view_tournament_stats', 'tournaments');

    res.json({ success: true, data: result.data });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message || 'Tournament service error' });
  }
});

exports.cancelTournament = asyncHandler(async (req, res) => {
  const { tournamentId } = req.params;
  const { reason } = req.body;

  const result = await sendTournamentCommand({
    action: 'CANCEL',
    data: { tournamentId, reason },
    actor: { userId: req.adminId, role: req.userRole }
  });

  if (result?.data) {
    try {
      await syncTournamentReadModel(result.data);
    } catch (err) {
      logger.error({ err }, 'Failed to sync tournament read model after cancel');
    }
  }

  await ActivityLogger.log(
    req.adminId,
    'cancel_tournament',
    'tournaments',
    { resourceId: tournamentId, reason }
  );

  logger.info(`Tournament cancelled: ${tournamentId}`);
  res.json({ success: true, data: result.data });
});

// Dashboard Statistics
exports.getDashboardStats = asyncHandler(async (req, res) => {
  try {
    const [authStats, walletStats, tournamentStats, paymentStats, systemWallet, activeSessions, agentUsers] = await Promise.all([
      axios.get(`${AUTH_SERVICE_URL}/stats`, { headers: getAuthHeaders(req) }).catch(() => ({ data: {} })),
      axios.get(`${WALLET_SERVICE_URL}/stats`, { headers: getAuthHeaders(req) }).catch(() => ({ data: {} })),
      sendTournamentCommand({
        action: 'STATS',
        data: {},
        actor: { userId: req.adminId, role: req.userRole }
      }).catch(() => ({ data: {} })),
      axios.get(`${PAYMENT_SERVICE_URL}/admin/stats`, { headers: getAuthHeaders(req) }).catch(() => ({ data: {} })),
      axios.get(`${WALLET_SERVICE_URL}/system/wallet`, { headers: getAuthHeaders(req) }).catch(() => ({ data: {} })),
      axios.get(`${GAME_SERVICE_URL}/sessions`, {
        headers: getAuthHeaders(req),
        params: { status: 'active', limit: 200 }
      }).catch(() => ({ data: {} })),
      axios.get(`${AUTH_SERVICE_URL}/users`, {
        headers: getAuthHeaders(req),
        params: { role: 'agent', limit: 1, offset: 0 }
      }).catch(() => ({ data: {} }))
    ]);

    const usersData = authStats.data?.data || authStats.data;
    const financialData = walletStats.data?.data || walletStats.data;
    const tournamentData = tournamentStats.data || {};
    const paymentData = paymentStats.data?.data || paymentStats.data || {};
    const systemWalletData = systemWallet.data?.data || systemWallet.data || {};
    const sessionsData = activeSessions.data?.data || activeSessions.data || [];
    const agentTotal = agentUsers.data?.pagination?.total || 0;

    const platformFees = Number(systemWalletData.balance || 0);
    const transactionFees = Number(paymentData.transactionFees || 0);
    const platformRevenue = platformFees + transactionFees;
    const pendingDeposits = Number(paymentData.pendingDeposits || 0);
    const pendingCashouts = Number(paymentData.pendingCashouts || 0);
    const activeSessionCount = Array.isArray(sessionsData) ? sessionsData.length : 0;

    const stats = {
      users: usersData,
      financial: {
        ...(financialData || {}),
        transactionFees,
        platformFees,
        platformRevenue
      },
      tournaments: tournamentData,
      pendingDeposits,
      pendingCashouts,
      activeSessions: activeSessionCount,
      totalAgents: Number(agentTotal || 0),
      timestamp: new Date().toISOString()
    };

    await ActivityLogger.log(req.adminId, 'view_dashboard', 'dashboard');

    // Emit dashboard stats update to connected admin clients
    emitDashboardStats(stats).catch((err) => {
      logger.error('Failed to emit dashboard stats update:', err);
    });

    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to fetch dashboard stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch dashboard statistics' 
    });
  }
});

exports.getAgents = asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    const response = await axios.get(`${AUTH_SERVICE_URL}/users`, {
      params: { role: 'agent', limit, offset },
      headers: getAuthHeaders(req)
    });

    await ActivityLogger.log(req.adminId, 'view_agents', 'agents', { count: response.data?.data?.length });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to get agents:', error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.error || 'Failed to get agents'
    });
  }
});

exports.createAgent = asyncHandler(async (req, res) => {
  const { username, email, password, phoneNumber, firstName, lastName, gender } = req.body;
  if (!username || !email || !password || !phoneNumber || !firstName || !lastName || !gender) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    const createResponse = await axios.post(`${AUTH_SERVICE_URL}/users`, {
      username,
      email,
      password,
      phoneNumber,
      firstName,
      lastName,
      gender,
      role: 'agent'
    }, { headers: getAuthHeaders(req) });

    const createdUser = createResponse.data?.data?.user;
    if (!createdUser?.userId) {
      return res.status(500).json({ success: false, error: 'Failed to create agent user' });
    }

    try {
      await axios.post(`${AGENT_SERVICE_URL}/admin/agents`, {
        userId: createdUser.userId
      }, { headers: getAuthHeaders(req) });
    } catch (err) {
      logger.error({ err }, 'Failed to initialize agent profile');
    }

    await ActivityLogger.log(req.adminId, 'create_agent', 'agents', { userId: createdUser.userId });

    // Emit user stats update when agent is created
    emitUserStats({
      totalAgents: (await axios.get(`${AUTH_SERVICE_URL}/stats`, { headers: getAuthHeaders(req) }))
        .data?.data?.totalAgents || 1
    }).catch((err) => {
      logger.error('Failed to emit user stats update:', err);
    });

    res.status(201).json({ success: true, data: { user: createdUser } });
  } catch (error) {
    logger.error('Failed to create agent:', error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.error || 'Failed to create agent'
    });
  }
});

// Game Management
exports.getGameSessions = asyncHandler(async (req, res) => {
  const { status, limit = 50 } = req.query;

  try {
    const response = await axios.get(`${GAME_SERVICE_URL}/sessions`, {
      params: { status, limit },
      headers: getAuthHeaders(req)
    });

    await ActivityLogger.log(req.adminId, 'view_game_sessions', 'games');
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to get game sessions:', error.message);
    res.status(error.response?.status || 500).json({ 
      success: false, 
      error: error.response?.data?.error || 'Failed to get game sessions' 
    });
  }
});

exports.cancelGameSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  const response = await axios.post(`${GAME_SERVICE_URL}/sessions/${sessionId}/cancel`, {}, {
    headers: getAuthHeaders(req)
  });

  await ActivityLogger.log(
    req.adminId,
    'cancel_game_session',
    'games',
    { resourceId: sessionId }
  );

  res.json(response.data);
});

exports.deleteGameSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  // Delete from game database directly
  const session = await gamePrisma.gameSession.findUnique({ where: { sessionId } });
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  await gamePrisma.gameSession.delete({ where: { sessionId } });

  await ActivityLogger.log(
    req.adminId,
    'delete_game_session',
    'games',
    { resourceId: sessionId }
  );

  logger.info(`Game session deleted: ${sessionId}`);
  res.json({ success: true, message: 'Game session deleted' });
});

// Wallet Management
exports.getWallets = asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0, type, status } = req.query;

  try {
    const response = await axios.get(`${WALLET_SERVICE_URL}/admin/wallets`, {
      params: { limit, offset, type, status },
      headers: getAuthHeaders(req)
    });

    await ActivityLogger.log(req.adminId, 'view_wallets', 'wallets');
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to get wallets:', error.message);
    res.status(error.response?.status || 500).json({ 
      success: false, 
      error: error.response?.data?.error || 'Failed to get wallets' 
    });
  }
});

exports.getWalletDetails = asyncHandler(async (req, res) => {
  const { walletId } = req.params;

  try {
    const response = await axios.get(`${WALLET_SERVICE_URL}/${walletId}`, {
      headers: getAuthHeaders(req)
    });

    await ActivityLogger.log(req.adminId, 'view_wallet', 'wallets', { resourceId: walletId });
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ 
      success: false, 
      error: error.response?.data?.error || 'Failed to get wallet details' 
    });
  }
});

exports.getTransactions = asyncHandler(async (req, res) => {
  const { limit = 100, offset = 0, status, type, startDate, endDate } = req.query;

  try {
    const response = await axios.get(`${WALLET_SERVICE_URL}/admin/transactions`, {
      params: { limit, offset, status, type, startDate, endDate },
      headers: getAuthHeaders(req)
    });

    await ActivityLogger.log(req.adminId, 'view_transactions', 'transactions');
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to get transactions:', error.message);
    res.status(error.response?.status || 500).json({ 
      success: false, 
      error: error.response?.data?.error || 'Failed to get transactions' 
    });
  }
});

exports.getPendingTransactions = asyncHandler(async (req, res) => {
  const { limit = 50 } = req.query;

  try {
    const response = await axios.get(`${WALLET_SERVICE_URL}/deposit-requests`, {
      params: { status: 'pending', limit },
      headers: getAuthHeaders(req)
    });

    await ActivityLogger.log(req.adminId, 'view_pending_transactions', 'transactions');
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to get pending transactions:', error.message);
    res.status(error.response?.status || 500).json({ 
      success: false, 
      error: error.response?.data?.error || 'Failed to get pending transactions' 
    });
  }
});

exports.approveTransaction = asyncHandler(async (req, res) => {
  const { transactionId } = req.params;
  const { notes } = req.body;

  try {
    const response = await axios.post(
      `${WALLET_SERVICE_URL}/deposit-requests/${transactionId}/approve`,
      { notes, approvedBy: req.adminId },
      { headers: getAuthHeaders(req) }
    );

    await ActivityLogger.log(
      req.adminId,
      'approve_transaction',
      'transactions',
      { resourceId: transactionId, notes }
    );

    logger.info(`Transaction approved: ${transactionId} by ${req.adminId}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ 
      success: false, 
      error: error.response?.data?.error || 'Failed to approve transaction' 
    });
  }
});

exports.rejectTransaction = asyncHandler(async (req, res) => {
  const { transactionId } = req.params;
  const { reason } = req.body;

  try {
    const response = await axios.post(
      `${WALLET_SERVICE_URL}/deposit-requests/${transactionId}/reject`,
      { reason, rejectedBy: req.adminId },
      { headers: getAuthHeaders(req) }
    );

    await ActivityLogger.log(
      req.adminId,
      'reject_transaction',
      'transactions',
      { resourceId: transactionId, reason }
    );

    logger.info(`Transaction rejected: ${transactionId} by ${req.adminId}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ 
      success: false, 
      error: error.response?.data?.error || 'Failed to reject transaction' 
    });
  }
});

exports.creditWallet = asyncHandler(async (req, res) => {
  const { walletId } = req.params;
  const { amount, description } = req.body;

  try {
    const response = await axios.post(
      `${WALLET_SERVICE_URL}/credit`,
      { walletId, amount, description, creditedBy: req.adminId },
      { headers: getAuthHeaders(req) }
    );

    await ActivityLogger.log(
      req.adminId,
      'credit_wallet',
      'wallets',
      { resourceId: walletId, amount, description }
    );

    logger.info(`Wallet credited: ${walletId} amount: ${amount}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ 
      success: false, 
      error: error.response?.data?.error || 'Failed to credit wallet' 
    });
  }
});

exports.debitWallet = asyncHandler(async (req, res) => {
  const { walletId } = req.params;
  const { amount, description } = req.body;

  try {
    const response = await axios.post(
      `${WALLET_SERVICE_URL}/debit`,
      { walletId, amount, description, debitedBy: req.adminId },
      { headers: getAuthHeaders(req) }
    );

    await ActivityLogger.log(
      req.adminId,
      'debit_wallet',
      'wallets',
      { resourceId: walletId, amount, description }
    );

    logger.info(`Wallet debited: ${walletId} amount: ${amount}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ 
      success: false, 
      error: error.response?.data?.error || 'Failed to debit wallet' 
    });
  }
});

// Tournament Management
exports.createTournament = asyncHandler(async (req, res) => {
  const tournamentData = req.body;
  tournamentData.createdBy = req.adminId;

  try {
    const result = await sendTournamentCommand({
      action: 'CREATE',
      data: tournamentData,
      actor: { userId: req.adminId, role: req.userRole }
    });

    if (result?.data) {
      try {
        await syncTournamentReadModel(result.data);
      } catch (err) {
        logger.error({ err }, 'Failed to sync tournament read model after create');
      }
    }

    await ActivityLogger.log(
      req.adminId,
      'create_tournament',
      'tournaments',
      { resourceId: result.data?.tournamentId, name: tournamentData.name }
    );

    logger.info(`Tournament created: ${result.data?.tournamentId}`);
    res.status(201).json({ success: true, data: result.data });
  } catch (error) {
    logger.error('Failed to create tournament:', error.message);
    res.status(502).json({ 
      success: false, 
      error: error.message || 'Failed to create tournament' 
    });
  }
});

exports.getTournaments = asyncHandler(async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;

  try {
    const result = await sendTournamentCommand({
      action: 'LIST',
      data: { status, limit, offset },
      actor: { userId: req.adminId, role: req.userRole }
    });

    await ActivityLogger.log(req.adminId, 'view_tournaments', 'tournaments');
    res.json({ success: true, data: result.data });
  } catch (error) {
    logger.error('Failed to get tournaments:', error.message);
    res.status(502).json({ 
      success: false, 
      error: error.message || 'Failed to get tournaments' 
    });
  }
});

exports.updateTournament = asyncHandler(async (req, res) => {
  const { tournamentId } = req.params;
  const updateData = req.body;

  try {
    const result = await sendTournamentCommand({
      action: 'UPDATE',
      data: { tournamentId, ...updateData, updatedBy: req.adminId },
      actor: { userId: req.adminId, role: req.userRole }
    });

    if (result?.data) {
      try {
        await syncTournamentReadModel(result.data);
      } catch (err) {
        logger.error({ err }, 'Failed to sync tournament read model after update');
      }
    }

    await ActivityLogger.log(
      req.adminId,
      'update_tournament',
      'tournaments',
      { resourceId: tournamentId, changes: updateData }
    );

    logger.info(`Tournament updated: ${tournamentId}`);
    res.json({ success: true, data: result.data });
  } catch (error) {
    res.status(502).json({ 
      success: false, 
      error: error.message || 'Failed to update tournament' 
    });
  }
});

exports.deleteTournament = asyncHandler(async (req, res) => {
  const { tournamentId } = req.params;

  try {
    await sendTournamentCommand({
      action: 'DELETE',
      data: { tournamentId },
      actor: { userId: req.adminId, role: req.userRole }
    });

    try {
      await markTournamentDeleted(tournamentId);
    } catch (err) {
      logger.error({ err }, 'Failed to sync tournament read model after delete');
    }

    await ActivityLogger.log(
      req.adminId,
      'delete_tournament',
      'tournaments',
      { resourceId: tournamentId }
    );

    logger.info(`Tournament deleted: ${tournamentId}`);
    res.json({ success: true, message: 'Tournament deleted successfully' });
  } catch (error) {
    res.status(502).json({ 
      success: false, 
      error: error.message || 'Failed to delete tournament' 
    });
  }
});

exports.startTournament = asyncHandler(async (req, res) => {
  const { tournamentId } = req.params;

  try {
    const result = await sendTournamentCommand({
      action: 'START',
      data: { tournamentId, startedBy: req.adminId },
      actor: { userId: req.adminId, role: req.userRole }
    });

    if (result?.data) {
      try {
        await syncTournamentReadModel(result.data);
      } catch (err) {
        logger.error({ err }, 'Failed to sync tournament read model after start');
      }
    }

    await ActivityLogger.log(
      req.adminId,
      'start_tournament',
      'tournaments',
      { resourceId: tournamentId }
    );

    logger.info(`Tournament started: ${tournamentId}`);
    res.json({ success: true, data: result.data });
  } catch (error) {
    res.status(502).json({ 
      success: false, 
      error: error.message || 'Failed to start tournament' 
    });
  }
});
