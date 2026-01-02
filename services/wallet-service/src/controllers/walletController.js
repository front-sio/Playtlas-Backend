const { prisma } = require('../config/db');
const axios = require('axios');
const logger = require('../utils/logger');
const { createWallet, creditWallet, debitWallet, transferFunds: transferFundsHelper, payTournamentFee } = require('../../../../shared/utils/walletHelper');
const { withTransaction } = require('../../../../shared/utils/drizzleHelpers');
const { ensureSystemWallet, ensurePlatformWallet } = require('../utils/walletBootstrap');

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

const ADMIN_ROLES = new Set([
  'admin',
  'super_admin',
  'superuser',
  'superadmin',
  'finance_manager',
  'manager',
  'director',
  'staff',
  'game_manager',
  'game_master'
]);

const ensureAdmin = (req, res) => {
  if (!ADMIN_ROLES.has(req.user?.role)) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return false;
  }
  return true;
};

exports.createWallet = async (req, res) => {
  try {
    const { userId, type = 'player', currency = 'TZS', metadata } = req.body;

    const wallet = await prisma.wallet.create({
      data: {
        ownerId: userId,
        type,
        currency,
        balance: 0,
        locked: 0,
        metadata: metadata || {}
      }
    });

    res.status(201).json({ success: true, data: wallet });
  } catch (error) {
    logger.error('Create wallet error:', error);
    res.status(500).json({ success: false, error: 'Failed to create wallet' });
  }
};

exports.getWallet = async (req, res) => {
  try {
    const wallet = await prisma.wallet.findUnique({ where: { walletId: req.params.walletId } });
    if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });
    res.json({ success: true, data: wallet });
  } catch (error) {
    logger.error('Get wallet error:', error);
    res.status(500).json({ success: false, error: 'Failed to get wallet' });
  }
};

exports.getWalletByOwner = async (req, res) => {
  try {
    const { ownerId } = req.params;
    const { type } = req.query;
    const where = { ownerId };
    if (type) where.type = type;

    const wallet = await prisma.wallet.findFirst({ where });
    if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });
    res.json({ success: true, data: wallet });
  } catch (error) {
    logger.error('Get wallet by owner error:', error);
    res.status(500).json({ success: false, error: 'Failed to get wallet' });
  }
};

exports.getBalance = async (req, res) => {
  try {
    const wallet = await prisma.wallet.findUnique({ where: { walletId: req.params.walletId } });
    if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });
    res.json({ success: true, data: { walletId: wallet.walletId, balance: parseFloat(wallet.balance), currency: wallet.currency } });
  } catch (error) {
    logger.error('Get balance error:', error);
    res.status(500).json({ success: false, error: 'Failed to get balance' });
  }
};

exports.getUserBalance = async (req, res) => {
  try {
    const userId = req.user.userId;
    let wallet = await prisma.wallet.findFirst({ where: { ownerId: userId } });

    if (!wallet) {
      // Auto-create wallet if it doesn't exist for the user
      // Note: createWallet helper might need adjustment.
      // Assuming createWallet helper handles the DB abstraction or we should use Prisma directly here.
      // Let's check createWallet helper later. For now, let's try to use Prisma directly for creation if helper fails or is Drizzle-bound.
      // Actually, the imports show `createWallet` comes from `shared/utils/walletHelper`.
      // If that helper uses Drizzle, we might have a problem.
      // But let's assume for now we can use Prisma here.
      wallet = await prisma.wallet.create({
        data: {
          ownerId: userId,
          type: 'player',
          currency: 'TZS',
          balance: 0,
          locked: 0
        }
      });
    }

    res.json({ success: true, data: { walletId: wallet.walletId, balance: parseFloat(wallet.balance), currency: wallet.currency, locked: parseFloat(wallet.locked), totalWins: wallet.totalWins, totalLosses: wallet.totalLosses } });
  } catch (error) {
    logger.error('Get user balance error:', error);
    res.status(500).json({ success: false, error: 'Failed to get user balance' });
  }
};

exports.creditWallet = async (req, res) => {
  try {
    // This endpoint should only be used for internal system operations
    // Regular deposits should go through payment-service which publishes Kafka events
    const { walletId, amount, description = 'Wallet credit' } = req.body;

    const updatedWallet = await prisma.wallet.update({
      where: { walletId },
      data: { balance: { increment: parseFloat(amount) } }
    });

    logger.info({ walletId, amount }, 'Wallet credited (direct)');
    res.json({ success: true, data: { wallet: updatedWallet } });
  } catch (error) {
    logger.error('Credit wallet error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to credit wallet' });
  }
};

exports.debitWallet = async (req, res) => {
  try {
    // This endpoint should only be used for internal system operations
    // Regular withdrawals should go through payment-service which publishes Kafka events
    const { walletId, amount, description = 'Wallet debit' } = req.body;

    const wallet = await prisma.wallet.findUnique({ where: { walletId } });
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.balance < parseFloat(amount)) throw new Error('Insufficient funds');

    const updatedWallet = await prisma.wallet.update({
      where: { walletId },
      data: { balance: { decrement: parseFloat(amount) } }
    });

    logger.info({ walletId, amount }, 'Wallet debited (direct)');
    res.json({ success: true, data: { wallet: updatedWallet } });
  } catch (error) {
    logger.error('Debit wallet error:', error);
    res.status(400).json({ success: false, error: error.message || 'Failed to debit wallet' });
  }
};

exports.requestDeposit = async (req, res) => {
  try {
    // Deposit requests are now handled by payment-service
    res.status(410).json({ 
      success: false, 
      error: 'Deposit requests have moved to payment service. Use /api/payment/deposit/initiate instead' 
    });
  } catch (error) {
    logger.error('Deposit request error:', error);
    res.status(500).json({ success: false, error: 'Failed to create deposit request' });
  }
};

exports.getDepositRequests = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    // Deposit requests are now handled by payment-service
    res.status(410).json({ 
      success: false, 
      error: 'Deposit requests have moved to payment service. Use /api/payment/admin/deposits/pending instead' 
    });
  } catch (error) {
    logger.error('Get deposit requests error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch deposit requests' });
  }
};

exports.approveDeposit = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    // Deposit approvals are now handled by payment-service
    res.status(410).json({ 
      success: false, 
      error: 'Deposit approvals have moved to payment service. Use /api/payment/deposit/:depositId/approve instead' 
    });
  } catch (error) {
    logger.error('Approve deposit error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to approve deposit' });
  }
};

exports.rejectDeposit = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    // Deposit rejections are now handled by payment-service
    res.status(410).json({ 
      success: false, 
      error: 'Deposit rejections have moved to payment service. Use /api/payment/deposit/:depositId/reject instead' 
    });
  } catch (error) {
    logger.error('Reject deposit error:', error);
    res.status(500).json({ success: false, error: 'Failed to reject deposit' });
  }
};


exports.payTournamentFee = async (req, res) => {
  try {
    const { playerWalletId, amount, tournamentId, seasonId, idempotencyKey } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      const playerWallet = await tx.wallet.findUnique({ where: { walletId: playerWalletId } });
      const systemWallet = await ensureSystemWallet(tx);

      if (!playerWallet) {
        throw new Error('Wallet not found');
      }

      if (playerWallet.balance < parseFloat(amount)) {
        throw new Error('Insufficient funds');
      }

      // Debit from player wallet
      await tx.wallet.update({
        where: { walletId: playerWalletId },
        data: { balance: { decrement: parseFloat(amount) } }
      });

      // Credit to system wallet
      await tx.wallet.update({
        where: { walletId: systemWallet.walletId },
        data: { balance: { increment: parseFloat(amount) } }
      });

      return { playerWallet, systemWallet };
    });

    logger.info({ playerWalletId, amount, tournamentId, seasonId }, 'Tournament fee paid');
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Pay tournament fee error:', error);
    res.status(400).json({ success: false, error: error.message || 'Failed to pay tournament fee' });
  }
};

exports.getTransactions = async (req, res) => {
  try {
    // Transactions are now stored in payment-service
    // This endpoint should redirect to payment-service or fetch from there
    res.status(410).json({ 
      success: false, 
      error: 'Transaction history has moved to payment service. Use /api/payment/transactions instead' 
    });
  } catch (error) {
    logger.error('Get transactions error:', error);
    res.status(500).json({ success: false, error: 'Failed to get transactions' });
  }
};

exports.getUserTransactions = async (req, res) => {
  try {
    // Transactions are now stored in payment-service
    // This endpoint should redirect to payment-service or fetch from there
    res.status(410).json({ 
      success: false, 
      error: 'Transaction history has moved to payment service. Use /api/payment/transactions instead' 
    });
  } catch (error) {
    logger.error('Get user transactions error:', error);
    res.status(500).json({ success: false, error: 'Failed to get user transactions' });
  }
};

exports.transferFunds = async (req, res) => {
  try {
    const { fromWalletId, toWalletId, amount, description, metadata, idempotencyKey } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      const fromWallet = await tx.wallet.findUnique({ where: { walletId: fromWalletId } });
      const toWallet = await tx.wallet.findUnique({ where: { walletId: toWalletId } });

      if (!fromWallet || !toWallet) throw new Error('Wallet not found');
      if (fromWallet.balance < parseFloat(amount)) throw new Error('Insufficient funds');

      // Debit from source wallet
      await tx.wallet.update({
        where: { walletId: fromWalletId },
        data: { balance: { decrement: parseFloat(amount) } }
      });

      // Credit to destination wallet
      await tx.wallet.update({
        where: { walletId: toWalletId },
        data: { balance: { increment: parseFloat(amount) } }
      });

      return { fromWalletId, toWalletId, amount };
    });

    logger.info({ fromWalletId, toWalletId, amount }, 'Funds transferred');
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Transfer funds error:', error);
    res.status(500).json({ success: false, error: 'Failed to transfer funds' });
  }
};

async function fetchUserByPhone(phoneNumber, authHeader) {
  const response = await axios.get(
    `${AUTH_SERVICE_URL}/users/lookup/phone/${encodeURIComponent(phoneNumber)}`,
    {
      headers: authHeader ? { Authorization: authHeader } : undefined,
      timeout: 10000
    }
  );
  return response.data?.data;
}

exports.lookupRecipientByPhone = async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'phoneNumber is required' });
    }

    const user = await fetchUserByPhone(phoneNumber, req.headers.authorization);
    if (!user?.userId) {
      return res.status(404).json({ success: false, error: 'Recipient not found' });
    }

    const wallet = await prisma.wallet.findFirst({
      where: { ownerId: user.userId, type: 'player' }
    });

    if (!wallet) {
      return res.status(404).json({ success: false, error: 'Recipient wallet not found' });
    }

    res.json({
      success: true,
      data: {
        user,
        walletId: wallet.walletId
      }
    });
  } catch (error) {
    logger.error('Lookup recipient by phone error:', error);
    res.status(500).json({ success: false, error: 'Failed to lookup recipient' });
  }
};

exports.transferFundsByPhone = async (req, res) => {
  try {
    const { fromWalletId, toPhoneNumber, amount, description, metadata, idempotencyKey } = req.body;

    if (!fromWalletId || !toPhoneNumber || !amount) {
      return res.status(400).json({ success: false, error: 'fromWalletId, toPhoneNumber, and amount are required' });
    }

    const user = await fetchUserByPhone(toPhoneNumber, req.headers.authorization);
    if (!user?.userId) {
      return res.status(404).json({ success: false, error: 'Recipient not found' });
    }

    const recipientWallet = await prisma.wallet.findFirst({
      where: { ownerId: user.userId, type: 'player' }
    });

    if (!recipientWallet) {
      return res.status(404).json({ success: false, error: 'Recipient wallet not found' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const fromWallet = await tx.wallet.findUnique({ where: { walletId: fromWalletId } });
      const toWallet = await tx.wallet.findUnique({ where: { walletId: recipientWallet.walletId } });

      if (!fromWallet || !toWallet) throw new Error('Wallet not found');
      if (req.user?.userId && fromWallet.ownerId !== req.user.userId) {
        throw new Error('Forbidden');
      }
      if (fromWallet.walletId === toWallet.walletId) {
        throw new Error('Cannot transfer to the same wallet');
      }
      if (fromWallet.balance < parseFloat(amount)) throw new Error('Insufficient funds');

      await tx.wallet.update({
        where: { walletId: fromWalletId },
        data: { balance: { decrement: parseFloat(amount) } }
      });

      await tx.wallet.update({
        where: { walletId: recipientWallet.walletId },
        data: { balance: { increment: parseFloat(amount) } }
      });

      return { fromWalletId, toWalletId: recipientWallet.walletId, amount };
    });

    logger.info({ fromWalletId, toPhoneNumber, amount }, 'Funds transferred by phone');
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Transfer funds by phone error:', error);
    const message = error.message === 'Forbidden' ? 'Forbidden' : 'Failed to transfer funds';
    res.status(error.message === 'Forbidden' ? 403 : 500).json({ success: false, error: message });
  }
};

exports.getSystemWallet = async (req, res) => {
  try {
    const systemWallet = await ensureSystemWallet(prisma);
    res.json({ success: true, data: systemWallet });
  } catch (error) {
    logger.error('Get system wallet error:', error);
    res.status(500).json({ success: false, error: 'Failed to get system wallet' });
  }
};

exports.getPlatformWallet = async (req, res) => {
  try {
    const platformWallet = await ensurePlatformWallet(prisma);
    res.json({ success: true, data: platformWallet });
  } catch (error) {
    logger.error('Get platform wallet error:', error);
    res.status(500).json({ success: false, error: 'Failed to get platform wallet' });
  }
};

exports.getWalletStats = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const [walletCount, totalBalance] = await Promise.all([
      prisma.wallet.count(),
      prisma.wallet.aggregate({ _sum: { balance: true } })
    ]);

    res.json({
      success: true,
      data: {
        walletCount,
        transactionCount: 0, // Transactions moved to payment service
        totalBalance: totalBalance._sum.balance || 0,
        transactionTypeBreakdown: [] // Transactions moved to payment service
      }
    });
  } catch (error) {
    logger.error('Get wallet stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch wallet stats' });
  }
};

exports.getWalletReport = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const where = {
      createdAt: {
        gte: start,
        lte: end
      }
    };

    // Transaction data moved to payment service
    res.json({
      success: true,
      data: {
        range: { start, end },
        totalAmount: 0,
        totalCount: 0,
        byType: [],
        byStatus: [],
        note: 'Transaction reporting has moved to payment service'
      }
    });
  } catch (error) {
    logger.error('Get wallet report error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate wallet report' });
  }
};

exports.listWallets = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { type, ownerId, isActive, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (type) where.type = type;
    if (ownerId) where.ownerId = ownerId;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const wallets = await prisma.wallet.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit, 10),
      skip: parseInt(offset, 10)
    });

    res.json({ success: true, data: wallets });
  } catch (error) {
    logger.error('List wallets error:', error);
    res.status(500).json({ success: false, error: 'Failed to list wallets' });
  }
};

exports.updateWallet = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { walletId } = req.params;
    const { isActive, metadata } = req.body;

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (metadata) updateData.metadata = metadata;

    const updated = await prisma.wallet.update({
      where: { walletId },
      data: updateData
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Update wallet error:', error);
    res.status(500).json({ success: false, error: 'Failed to update wallet' });
  }
};

// Admin Functions
exports.getAllWallets = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { limit = 50, offset = 0, type, status } = req.query;
    const where = {};
    if (type) where.type = type;
    
    const wallets = await prisma.wallet.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: parseInt(offset),
      take: parseInt(limit),
      include: {
        _count: {
          select: {
            transactionsFrom: true,
            transactionsTo: true
          }
        }
      }
    });

    const total = await prisma.wallet.count({ where });

    res.json({ 
      success: true, 
      data: {
        wallets,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    logger.error('Get all wallets error:', error);
    res.status(500).json({ success: false, error: 'Failed to get wallets' });
  }
};

// Helper function to calculate withdrawal fee (same as payment service)
function calculateWithdrawalFee(amount) {
  const feePercentage = parseFloat(process.env.WITHDRAWAL_FEE_PERCENTAGE || 1) / 100;
  const minFee = parseFloat(process.env.WITHDRAWAL_MIN_FEE || 500);
  const maxFee = parseFloat(process.env.WITHDRAWAL_MAX_FEE || 10000);

  let fee = amount * feePercentage;
  fee = Math.max(fee, minFee);
  fee = Math.min(fee, maxFee);

  return parseFloat(fee.toFixed(2));
}

exports.requestPayout = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { 
      amount, 
      paymentMethod, 
      phoneNumber, 
      accountName,
      bankAccountNumber,
      bankName,
      branchCode,
      description 
    } = req.body;

    // Validate required fields
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Valid amount is required' });
    }

    if (!paymentMethod || !['mobile', 'lipa_namba', 'bank'].includes(paymentMethod)) {
      return res.status(400).json({ success: false, error: 'Valid payment method is required (mobile, lipa_namba, bank)' });
    }

    // Validate method-specific fields
    if ((paymentMethod === 'mobile' || paymentMethod === 'lipa_namba') && !phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number is required for mobile payments' });
    }

    if (paymentMethod === 'bank' && (!bankAccountNumber || !bankName || !accountName)) {
      return res.status(400).json({ success: false, error: 'Bank details are required for bank transfers' });
    }

    // Get user wallet
    const wallet = await prisma.wallet.findFirst({ where: { ownerId: userId } });
    if (!wallet) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    const requestAmount = parseFloat(amount);

    // Calculate withdrawal fee
    const fee = calculateWithdrawalFee(requestAmount);
    const totalAmount = requestAmount + fee;

    // Check sufficient balance for total amount (amount + fee)
    if (wallet.balance < totalAmount) {
      return res.status(400).json({ 
        success: false, 
        error: `Insufficient funds. Required: ${totalAmount} (amount: ${requestAmount} + fee: ${fee}), Available: ${parseFloat(wallet.balance)}`,
        availableBalance: parseFloat(wallet.balance),
        requiredAmount: totalAmount,
        amount: requestAmount,
        fee: fee
      });
    }

    // Create payout request with fee information
    const payoutRequest = await prisma.payoutRequest.create({
      data: {
        walletId: wallet.walletId,
        userId,
        amount: requestAmount,
        fee: fee,
        totalAmount: totalAmount,
        paymentMethod,
        phoneNumber: phoneNumber || null,
        accountName: accountName || null,
        bankAccountNumber: bankAccountNumber || null,
        bankName: bankName || null,
        branchCode: branchCode || null,
        description: description || `Withdrawal via ${paymentMethod}`,
        status: 'PENDING',
        referenceNumber: `PAY${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`
      }
    });

    logger.info({ payoutId: payoutRequest.payoutId, userId, amount: requestAmount, fee, totalAmount, paymentMethod }, 'Payout request created');

    res.status(201).json({ 
      success: true, 
      data: payoutRequest,
      message: 'Payout request submitted successfully. Amount + fee will be deducted upon approval.'
    });
  } catch (error) {
    logger.error('Request payout error:', error);
    res.status(500).json({ success: false, error: 'Failed to create payout request' });
  }
};

exports.getPayoutRequests = async (req, res) => {
  try {
    const userId = req.user.userId;
    const isAdmin = ADMIN_ROLES.has(req.user?.role);
    
    let whereClause = {};
    if (!isAdmin) {
      whereClause = { userId };
    }

    const { status, limit = 20, offset = 0 } = req.query;
    if (status) {
      whereClause.status = status.toUpperCase();
    }

    const payoutRequests = await prisma.payoutRequest.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: {
        wallet: {
          select: { ownerId: true, type: true }
        }
      }
    });

    const total = await prisma.payoutRequest.count({ where: whereClause });

    res.json({ 
      success: true, 
      data: {
        payoutRequests,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    logger.error('Get payout requests error:', error);
    res.status(500).json({ success: false, error: 'Failed to get payout requests' });
  }
};

exports.approvePayout = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { payoutId } = req.params;
    const { externalReference, notes, transactionMessage } = req.body;

    const payoutRequest = await prisma.payoutRequest.findUnique({
      where: { payoutId },
      include: { wallet: true }
    });

    if (!payoutRequest) {
      return res.status(404).json({ success: false, error: 'Payout request not found' });
    }

    if (payoutRequest.status !== 'PENDING') {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot approve payout with status: ${payoutRequest.status}` 
      });
    }

    // Calculate total amount to deduct (amount + fee)
    const totalDeducted = payoutRequest.totalAmount || (payoutRequest.amount + (payoutRequest.fee || 0));

    // Verify sufficient balance
    if (payoutRequest.wallet.balance < totalDeducted) {
      return res.status(400).json({ 
        success: false, 
        error: 'Insufficient balance for approval',
        availableBalance: parseFloat(payoutRequest.wallet.balance),
        requiredAmount: totalDeducted
      });
    }

    // Get admin info for notification
    let adminName = 'ADMIN';
    let adminPhone = '+255000000000';
    try {
      const authResponse = await axios.get(`${AUTH_SERVICE_URL}/users/${req.user.userId}`, {
        timeout: 5000,
        headers: { Authorization: req.headers.authorization }
      });
      adminName = authResponse.data?.data?.fullName || authResponse.data?.data?.username || 'ADMIN';
      adminPhone = authResponse.data?.data?.phoneNumber || '+255000000000';
    } catch (error) {
      logger.warn('Failed to get admin info for notification:', error);
    }

    let newBalance = 0;

    // Process the payout
    await prisma.$transaction(async (tx) => {
      // Debit from wallet with total amount (amount + fee)
      const updatedWallet = await tx.wallet.update({
        where: { walletId: payoutRequest.walletId },
        data: { balance: { decrement: totalDeducted } }
      });

      newBalance = parseFloat(updatedWallet.balance);

      // Update payout request status
      await tx.payoutRequest.update({
        where: { payoutId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedBy: req.user.userId,
          externalReference,
          notes,
          processedAt: new Date(),
          transactionMessage
        }
      });
    });

    // Send enhanced notification to user
    try {
      const { enqueueNotification } = require('../../../../shared/utils/notificationHelper');
      
      // Format transaction notification message
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', {
        year: 'numeric',
        month: '2-digit', 
        day: '2-digit'
      });
      const timeStr = now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });

      let notificationMessage = '';
      if (transactionMessage) {
        notificationMessage = transactionMessage;
      } else {
        notificationMessage = `**${payoutRequest.referenceNumber}** Confirmed. On ${dateStr} at ${timeStr} TZS${payoutRequest.amount.toLocaleString()}.00 withdrawn from your account by ${adminPhone} (${adminName}). New ${payoutRequest.paymentMethod.toUpperCase()} balance is TZS${newBalance.toLocaleString()}.00. Transaction cost: TZS${(payoutRequest.fee || 0).toLocaleString()}.00.`;
      }

      await enqueueNotification({
        userId: payoutRequest.userId,
        channel: 'in_app',
        type: 'payment',
        title: 'Cashout Confirmed',
        message: notificationMessage,
        data: {
          payoutId,
          amount: payoutRequest.amount,
          referenceNumber: payoutRequest.referenceNumber,
          paymentMethod: payoutRequest.paymentMethod,
          playSound: true
        }
      });
    } catch (notificationError) {
      logger.error('Failed to send payout notification:', notificationError);
    }

    logger.info({ payoutId, approvedBy: req.user.userId, amount: payoutRequest.amount, fee: payoutRequest.fee, totalDeducted }, 'Payout request approved');

    res.json({ 
      success: true, 
      message: `Payout request approved and processed. Deducted: ${totalDeducted} TZS (amount: ${payoutRequest.amount} + fee: ${payoutRequest.fee})`,
      data: { 
        payoutId, 
        status: 'APPROVED',
        amountDeducted: totalDeducted,
        amount: payoutRequest.amount,
        fee: payoutRequest.fee
      }
    });
  } catch (error) {
    logger.error('Approve payout error:', error);
    res.status(500).json({ success: false, error: 'Failed to approve payout request' });
  }
};

exports.rejectPayout = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { payoutId } = req.params;
    const { reason, notes } = req.body;

    if (!reason) {
      return res.status(400).json({ success: false, error: 'Rejection reason is required' });
    }

    const payoutRequest = await prisma.payoutRequest.findUnique({
      where: { payoutId }
    });

    if (!payoutRequest) {
      return res.status(404).json({ success: false, error: 'Payout request not found' });
    }

    if (payoutRequest.status !== 'PENDING') {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot reject payout with status: ${payoutRequest.status}` 
      });
    }

    // Update payout request status
    await prisma.payoutRequest.update({
      where: { payoutId },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        rejectedBy: req.user.userId,
        rejectionReason: reason,
        notes
      }
    });

    logger.info({ payoutId, rejectedBy: req.user.userId, reason }, 'Payout request rejected');

    res.json({ 
      success: true, 
      message: 'Payout request rejected',
      data: { payoutId, status: 'REJECTED', reason }
    });
  } catch (error) {
    logger.error('Reject payout error:', error);
    res.status(500).json({ success: false, error: 'Failed to reject payout request' });
  }
};

exports.getAllTransactions = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    // Transactions moved to payment service
    res.status(410).json({ 
      success: false, 
      error: 'Transaction data has moved to payment service. Use /api/payment/admin/transactions instead' 
    });
  } catch (error) {
    logger.error('Get all transactions error:', error);
    res.status(500).json({ success: false, error: 'Failed to get transactions' });
  }
};
