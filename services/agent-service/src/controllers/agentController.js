const axios = require('axios');
const jwt = require('jsonwebtoken');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { emitAgentWalletCreated } = require('../utils/socketEmitter');

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002';
const MATCHMAKING_SERVICE_URL = process.env.MATCHMAKING_SERVICE_URL || 'http://localhost:3009';
const SERVICE_JWT_TOKEN = process.env.SERVICE_JWT_TOKEN || process.env.PAYMENT_SERVICE_TOKEN;
let cachedServiceToken = null;
let cachedServiceTokenExpiry = 0;

function getServiceToken() {
  if (SERVICE_JWT_TOKEN) return SERVICE_JWT_TOKEN;
  const now = Date.now();
  if (cachedServiceToken && now < cachedServiceTokenExpiry) {
    return cachedServiceToken;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const token = jwt.sign({ userId: 'system', role: 'service' }, secret, { expiresIn: '5m' });
    cachedServiceToken = token;
    cachedServiceTokenExpiry = now + 4 * 60 * 1000;
    return token;
  } catch (err) {
    logger.error({ err }, '[agent] Failed to create service token');
    return null;
  }
}

const getAuthHeaders = (req) => {
  const authHeader = req.headers.authorization;
  return authHeader ? { Authorization: authHeader } : {};
};

async function fetchCurrentUser(req) {
  try {
    const response = await axios.get(`${AUTH_SERVICE_URL}/me`, {
      headers: getAuthHeaders(req)
    });
    return response.data?.data || null;
  } catch (error) {
    logger.warn('Failed to fetch current user:', error.message);
    return null;
  }
}

async function ensureAgentProfile(userId, clubId) {
  let agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) {
    if (!clubId) {
      throw new Error('clubId is required to create agent profile');
    }
    agent = await prisma.agentProfile.create({ data: { userId, clubId, status: 'offline' } });
  } else if (!agent.clubId && clubId) {
    agent = await prisma.agentProfile.update({
      where: { agentId: agent.agentId },
      data: { clubId }
    });
  }
  return agent;
}

async function ensureAgentWallet(userId) {
  try {
    const walletResponse = await axios.get(`${WALLET_SERVICE_URL}/owner/${userId}`, {
      params: { type: 'agent' }
    });
    return walletResponse.data?.data;
  } catch (error) {
    if (error.response?.status !== 404) throw error;
  }

  const created = await axios.post(`${WALLET_SERVICE_URL}/create`, {
    userId,
    type: 'agent',
    currency: 'TZS'
  });

  // Emit event when new agent wallet is created
  if (created.data?.data) {
    emitAgentWalletCreated({ userId, walletId: created.data.data.walletId }).catch((err) => {
      logger.error('Failed to emit agent wallet created event:', err);
    });
  }

  return created.data?.data;
}

exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const currentUser = await fetchCurrentUser(req);
    const clubId = currentUser?.clubId || null;
    const agent = await ensureAgentProfile(userId, clubId);
    const wallet = await ensureAgentWallet(userId);
    res.json({ success: true, data: { agent, wallet } });
  } catch (error) {
    logger.error('Get profile error:', error);
    const message = error.message || 'Failed to get agent profile';
    const status = message.includes('clubId is required') ? 400 : 500;
    res.status(status).json({ success: false, error: message });
  }
};

exports.registerPlayer = async (req, res) => {
  try {
    const userId = req.user.userId;
    const currentUser = await fetchCurrentUser(req);
    const clubId = currentUser?.clubId || null;
    const agent = await ensureAgentProfile(userId, clubId);
    if (!agent?.clubId) {
      return res.status(400).json({
        success: false,
        error: 'Agent is missing a club assignment. Please contact admin to assign a club.'
      });
    }

    const { username, email, password, phoneNumber, firstName, lastName, gender } = req.body;
    if (!username || !email || !password || !phoneNumber) {
      return res.status(400).json({ success: false, error: 'username, email, phoneNumber, and password are required' });
    }

    const response = await axios.post(`${AUTH_SERVICE_URL}/register`, {
      username,
      email,
      password,
      phoneNumber,
      firstName,
      lastName,
      gender,
      clubId: agent.clubId,
      registeredByAgentId: userId
    });

    const createdUser = response.data?.data?.user;
    if (!createdUser?.userId) {
      return res.status(500).json({ success: false, error: 'Failed to create player' });
    }

    await prisma.agentPlayer.create({
      data: {
        agentId: agent.agentId,
        playerId: createdUser.userId
      }
    });

    await ensureAgentWallet(userId);

    logger.info({ agentId: agent.agentId, playerId: createdUser.userId }, '[agent] Player registered');

    res.json({ success: true, data: { playerId: createdUser.userId, user: createdUser } });
  } catch (error) {
    logger.error('Register player error:', error);
    const message = error.response?.data?.error || error.message || 'Failed to register player';
    const status = message.includes('clubId is required') ? 400 : 500;
    res.status(status).json({ success: false, error: message });
  }
};

exports.listPlayers = async (req, res) => {
  try {
    const userId = req.user.userId;
    const agent = await ensureAgentProfile(userId);

    const players = await prisma.agentPlayer.findMany({
      where: { agentId: agent.agentId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, data: players });
  } catch (error) {
    logger.error('List players error:', error);
    res.status(500).json({ success: false, error: 'Failed to list players' });
  }
};

exports.listDevicesByClub = async (req, res) => {
  try {
    const clubId = String(req.query.clubId || '');
    if (!clubId) {
      return res.status(400).json({ success: false, error: 'clubId is required' });
    }

    const statusFilter = String(req.query.status || '').toLowerCase();
    let status = undefined;
    if (statusFilter) {
      status =
        statusFilter === 'online'
          ? { in: ['online', 'active'] }
          : statusFilter === 'offline'
            ? { in: ['offline', 'inactive'] }
            : statusFilter;
    }

    const devices = await prisma.device.findMany({
      where: {
        clubId,
        ...(status ? { status } : {})
      },
      select: {
        deviceId: true,
        agentId: true,
        clubId: true,
        name: true,
        status: true,
        capacitySlots: true
      },
      orderBy: { createdAt: 'asc' }
    });

    res.json({ success: true, data: devices });
  } catch (error) {
    logger.error('List club devices error:', error);
    res.status(500).json({ success: false, error: 'Failed to list club devices' });
  }
};

exports.transferFloat = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { phoneNumber, amount } = req.body;

    if (!phoneNumber || !amount) {
      return res.status(400).json({ success: false, error: 'phoneNumber and amount are required' });
    }

    if (amount <= 0) {
      return res.status(400).json({ success: false, error: 'Amount must be greater than 0' });
    }

    const agentWallet = await ensureAgentWallet(userId);

    // Use wallet service's transfer by phone endpoint
    const transfer = await axios.post(`${WALLET_SERVICE_URL}/transfer/phone`, {
      fromWalletId: agentWallet.walletId,
      phoneNumber,
      amount,
      description: 'Agent float transfer',
      metadata: { agentId: userId }
    });

    logger.info({ agentId: userId, amount, recipientPhone: phoneNumber }, '[agent] Float transferred');

    res.json({ success: true, data: transfer.data?.data || transfer.data });
  } catch (error) {
    logger.error('Transfer float error:', error);
    res.status(500).json({
      success: false,
      error: error.response?.data?.error || 'Failed to transfer float'
    });
  }
};

exports.lookupRecipientByPhone = async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'phoneNumber is required' });
    }

    // Look up recipient wallet by phone number
    const walletResponse = await axios.get(`${WALLET_SERVICE_URL}/transfer/lookup/phone/${phoneNumber}`);

    const walletData = walletResponse.data?.data;
    if (!walletData) {
      return res.status(404).json({ success: false, error: 'Recipient wallet not found' });
    }

    res.json({ success: true, data: walletData });
  } catch (error) {
    logger.error('Lookup recipient by phone error:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.error || 'Failed to lookup recipient'
    });
  }
};

exports.createAgentProfile = async (req, res) => {
  try {
    const { userId, clubId } = req.body;
    if (!userId || !clubId) {
      return res.status(400).json({ success: false, error: 'userId and clubId are required' });
    }

    const agent = await ensureAgentProfile(userId, clubId);
    const wallet = await ensureAgentWallet(userId);

    res.json({ success: true, data: { agent, wallet } });
  } catch (error) {
    logger.error('Create agent profile error:', error);
    const message = error.message || 'Failed to create agent profile';
    const status = message.includes('clubId is required') ? 400 : 500;
    res.status(status).json({ success: false, error: message });
  }
};

exports.listEarnings = async (req, res) => {
  try {
    const userId = req.user.userId;
    const agent = await ensureAgentProfile(userId);
    const { startDate, endDate, status } = req.query;
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const whereClause = {
      agentId: agent.agentId,
      earningsDate: {
        gte: start,
        lte: end
      }
    };
    if (status) {
      whereClause.status = status;
    }

    const earnings = await prisma.agentEarningsDaily.findMany({
      where: whereClause,
      orderBy: { earningsDate: 'desc' }
    });

    res.json({ success: true, data: earnings });
  } catch (error) {
    logger.error('List earnings error:', error);
    res.status(500).json({ success: false, error: 'Failed to list earnings' });
  }
};

const formatAgentName = (user) => {
  if (!user) return null;
  if (user.username) return user.username;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return fullName || user.phoneNumber || null;
};

exports.listAgentsAdmin = async (req, res) => {
  try {
    const { limit = 50, offset = 0, startDate, endDate } = req.query;
    const take = parseInt(limit, 10);
    const skip = parseInt(offset, 10);

    const agents = await prisma.agentProfile.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: {
        _count: {
          select: { players: true }
        }
      }
    });

    const agentIds = agents.map((agent) => agent.agentId);
    const payoutWhere = { agentId: { in: agentIds } };

    if (startDate || endDate) {
      payoutWhere.createdAt = {};
      if (startDate) payoutWhere.createdAt.gte = new Date(startDate);
      if (endDate) payoutWhere.createdAt.lte = new Date(endDate);
    }

    const payouts = agentIds.length
      ? await prisma.agentSeasonPayout.groupBy({
        by: ['agentId'],
        _sum: { amount: true },
        where: payoutWhere
      })
      : [];

    const payoutMap = new Map(
      payouts.map((row) => [row.agentId, Number(row._sum.amount || 0)])
    );

    let users = [];
    try {
      const response = await axios.get(`${AUTH_SERVICE_URL}/users`, {
        params: { role: 'agent', limit: 1000, offset: 0 },
        headers: getAuthHeaders(req)
      });
      users = response.data?.data || [];
    } catch (error) {
      logger.warn('Failed to fetch agent user info:', error.message);
    }

    const userMap = new Map(users.map((user) => [user.userId, user]));

    const data = agents.map((agent) => {
      const user = userMap.get(agent.userId);
      return {
        agentId: agent.agentId,
        userId: agent.userId,
        agentName: formatAgentName(user),
        clubId: agent.clubId,
        playersRegistered: agent._count.players,
        monthRevenue: payoutMap.get(agent.agentId) || 0,
        createdAt: agent.createdAt
      };
    });

    const total = await prisma.agentProfile.count();

    res.json({
      success: true,
      data,
      pagination: {
        total,
        limit: take,
        offset: skip,
        pages: Math.ceil(total / take)
      }
    });
  } catch (error) {
    logger.error('List agents admin error:', error);
    res.status(500).json({ success: false, error: 'Failed to list agents' });
  }
};

exports.listAgentPlayersAdmin = async (req, res) => {
  try {
    const { agentId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const take = parseInt(limit, 10);
    const skip = parseInt(offset, 10);

    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId is required' });
    }

    const [players, total] = await Promise.all([
      prisma.agentPlayer.findMany({
        where: { agentId },
        orderBy: { createdAt: 'desc' },
        take,
        skip
      }),
      prisma.agentPlayer.count({ where: { agentId } })
    ]);

    res.json({
      success: true,
      data: players,
      pagination: {
        total,
        limit: take,
        offset: skip,
        pages: Math.ceil(total / take)
      }
    });
  } catch (error) {
    logger.error('List agent players admin error:', error);
    res.status(500).json({ success: false, error: 'Failed to list agent players' });
  }
};

exports.listAgentPayoutsAdmin = async (req, res) => {
  try {
    const { agentId } = req.params;
    const { limit = 50, offset = 0, startDate, endDate } = req.query;
    const take = parseInt(limit, 10);
    const skip = parseInt(offset, 10);

    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId is required' });
    }

    const where = { agentId };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [payouts, total] = await Promise.all([
      prisma.agentSeasonPayout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip
      }),
      prisma.agentSeasonPayout.count({ where })
    ]);

    res.json({
      success: true,
      data: payouts,
      pagination: {
        total,
        limit: take,
        offset: skip,
        pages: Math.ceil(total / take)
      }
    });
  } catch (error) {
    logger.error('List agent payouts admin error:', error);
    res.status(500).json({ success: false, error: 'Failed to list agent payouts' });
  }
};

exports.listAgentsByClub = async (req, res) => {
  try {
    const { clubId, limit = 200, offset = 0, status } = req.query;
    if (!clubId) {
      return res.status(400).json({ success: false, error: 'clubId is required' });
    }

    const where = { clubId };
    const statusFilter = String(status || '').toLowerCase();
    if (statusFilter === 'online' || statusFilter === 'active') {
      where.isActive = true;
      where.status = 'online';
    } else if (statusFilter === 'offline' || statusFilter === 'inactive') {
      where.isActive = true;
      where.status = 'offline';
    } else if (statusFilter) {
      where.isActive = true;
      where.status = statusFilter;
    }

    const agents = await prisma.agentProfile.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit, 10),
      skip: parseInt(offset, 10)
    });

    res.json({ success: true, data: agents });
  } catch (error) {
    logger.error('List agents by club error:', error);
    res.status(500).json({ success: false, error: 'Failed to list agents' });
  }
};

exports.updateAgentStatusInternal = async (req, res) => {
  try {
    const { userId, status } = req.body || {};
    if (!userId || !status) {
      return res.status(400).json({ success: false, error: 'userId and status are required' });
    }

    const normalized = String(status).toLowerCase();
    if (!['online', 'offline', 'active', 'inactive'].includes(normalized)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    const resolvedStatus = normalized === 'active'
      ? 'online'
      : normalized === 'inactive'
        ? 'offline'
        : normalized;

    const agent = await prisma.agentProfile.findUnique({ where: { userId } });
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent profile not found' });
    }

    const updated = await prisma.agentProfile.update({
      where: { agentId: agent.agentId },
      data: {
        status: resolvedStatus,
        lastSeenAt: new Date()
      }
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Update agent status error:', error);
    res.status(500).json({ success: false, error: 'Failed to update agent status' });
  }
};

exports.listAssignedMatches = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const agent = await ensureAgentProfile(userId);
    const serviceToken = getServiceToken();
    const headers = serviceToken ? { Authorization: `Bearer ${serviceToken}` } : getAuthHeaders(req);
    const params = { ...(req.query || {}) };
    if (serviceToken && agent?.agentId) {
      params.agentId = agent.agentId;
    }

    const response = await axios.get(`${MATCHMAKING_SERVICE_URL}/matchmaking/agent/matches`, {
      headers,
      params
    });
    res.json(response.data);
  } catch (error) {
    logger.error('List assigned matches error:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.error || 'Failed to load assigned matches'
    });
  }
};
