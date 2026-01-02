const axios = require('axios');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { emitAgentWalletCreated } = require('../utils/socketEmitter');

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3007';

const getAuthHeaders = (req) => {
  const authHeader = req.headers.authorization;
  return authHeader ? { Authorization: authHeader } : {};
};

async function ensureAgentProfile(userId) {
  let agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) {
    agent = await prisma.agentProfile.create({ data: { userId } });
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
    const agent = await ensureAgentProfile(userId);
    const wallet = await ensureAgentWallet(userId);
    res.json({ success: true, data: { agent, wallet } });
  } catch (error) {
    logger.error('Get profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to get agent profile' });
  }
};

exports.registerPlayer = async (req, res) => {
  try {
    const userId = req.user.userId;
    const agent = await ensureAgentProfile(userId);

    const { username, email, password, phoneNumber, firstName, lastName, gender } = req.body;
    if (!username || !email || !password || !phoneNumber) {
      return res.status(400).json({ success: false, error: 'username, email, phoneNumber, and password are required' });
    }

    const response = await axios.post(`${AUTH_SERVICE_URL}/auth/register`, {
      username,
      email,
      password,
      phoneNumber,
      firstName,
      lastName,
      gender
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
    res.status(500).json({ success: false, error: error.response?.data?.error || 'Failed to register player' });
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
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const agent = await ensureAgentProfile(userId);
    const wallet = await ensureAgentWallet(userId);

    res.json({ success: true, data: { agent, wallet } });
  } catch (error) {
    logger.error('Create agent profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to create agent profile' });
  }
};

exports.listEarnings = async (req, res) => {
  try {
    const userId = req.user.userId;
    const agent = await ensureAgentProfile(userId);

    const payouts = await prisma.agentSeasonPayout.findMany({
      where: { agentId: agent.agentId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, data: payouts });
  } catch (error) {
    logger.error('List earnings error:', error);
    res.status(500).json({ success: false, error: 'Failed to list earnings' });
  }
};
