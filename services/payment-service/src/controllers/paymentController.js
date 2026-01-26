const paymentProcessingService = require('../services/paymentProcessing.js');
const { prisma } = require('../config/db.js');
const { logger } = require('../utils/logger.js');
const { sanitizePhoneNumber, verifyWebhookSignature } = require('../utils/security.js');
const MobileMoneyMessageService = require('../services/mobileMoneyMessageService.js');

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

exports.initiateDeposit = async (req, res) => {
  try {
    const { walletId, provider, phoneNumber, amount } = req.body;
    const userId = req.user?.userId || req.body.userId;

    if (!walletId || !provider || !phoneNumber || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await paymentProcessingService.initiateDeposit({
      userId,
      walletId,
      provider,
      phoneNumber,
      amount: parseFloat(amount),
      metadata: { ip: req.ip, userAgent: req.get('user-agent') }
    });

    res.json(result);
  } catch (error) {
    logger.error('Deposit initiation error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getDepositStatus = async (req, res) => {
  try {
    const { referenceNumber } = req.params;
    const userId = req.user?.userId || req.query.userId;

    const whereClause = { referenceNumber: referenceNumber };
    if (userId) {
      whereClause.userId = userId;
    }

    const result = await prisma.deposit.findFirst({
      where: whereClause,
      select: {
        depositId: true,
        referenceNumber: true,
        amount: true,
        provider: true,
        status: true,
        createdAt: true,
        completedAt: true,
        failureReason: true,
        expiresAt: true,
      }
    });

    if (!result) {
      return res.status(404).json({ error: 'Deposit not found' });
    }

    res.json(result);
  } catch (error) {
    logger.error('Get deposit status error:', error);
    res.status(500).json({ error: 'Failed to get deposit status' });
  }
};

exports.initiateWithdrawal = async (req, res) => {
  try {
    const { walletId, methodId, amount, paymentMethod, phoneNumber, description, withdrawalSource } = req.body;
    const userId = req.user?.userId || req.body.userId;

    // Server-side validation
    if (!walletId || !amount) {
      return res.status(400).json({ error: 'Missing required fields: walletId and amount are required' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Validate amount is a positive number
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount: must be a positive number' });
    }

    // Validate phone number format if provided
    if (phoneNumber && !/^[0-9\+\-\s]+$/.test(phoneNumber)) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // Sanitize payment method
    if (paymentMethod && typeof paymentMethod !== 'string') {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    // Validate description length
    if (description && description.length > 500) {
      return res.status(400).json({ error: 'Description too long (max 500 characters)' });
    }

    let normalizedSource = null;
    if (withdrawalSource) {
      const sourceValue = String(withdrawalSource).toLowerCase();
      if (!['deposit', 'revenue'].includes(sourceValue)) {
        return res.status(400).json({ error: 'Invalid withdrawalSource. Use deposit or revenue.' });
      }
      normalizedSource = sourceValue;
    }

    // Validate wallet exists and belongs to the user via wallet service
    try {
      const axios = require('axios');
      const walletServiceUrl = process.env.WALLET_SERVICE_URL || 'http://wallet-service:3000';
      
      const walletResponse = await axios.get(`${walletServiceUrl}/${walletId}`, {
        timeout: 5000,
        headers: {
          'Authorization': req.headers.authorization,
          'Content-Type': 'application/json'
        }
      });

      // Wallet service returns { success: true, data: wallet }
      const wallet = walletResponse.data?.data;
      if (!wallet || wallet.ownerId !== userId) {
        return res.status(404).json({ error: 'Wallet not found or does not belong to this user' });
      }
    } catch (walletError) {
      logger.error('Wallet validation error:', walletError);
      
      // If it's a 404 from the wallet service, return specific error
      if (walletError.response?.status === 404) {
        return res.status(404).json({ error: 'Wallet not found or does not belong to this user' });
      }
      
      // For other errors, return generic validation error
      return res.status(500).json({ error: 'Failed to validate wallet' });
    }


    // Use paymentMethod/provider name if provided, otherwise use methodId
    let finalMethodId = methodId;
    if (paymentMethod && phoneNumber) {
      try {
        // Check if payment method already exists
        const sanitizedPhone = sanitizePhoneNumber(phoneNumber);
        logger.info('Sanitized phone number:', { original: phoneNumber, sanitized: sanitizedPhone });
        
        const existingMethod = await prisma.paymentMethod.findFirst({
          where: {
            userId: userId,
            provider: paymentMethod,
            phoneNumber: sanitizedPhone
          }
        });

        if (existingMethod) {
          finalMethodId = existingMethod.methodId;
          logger.info('Using existing payment method:', { methodId: finalMethodId, provider: paymentMethod });
        } else {
          // Create a new payment method for this withdrawal
          logger.info('Creating new payment method:', { userId, provider: paymentMethod, phone: sanitizedPhone });
          
          const newMethod = await prisma.paymentMethod.create({
            data: {
              userId: userId,
              provider: paymentMethod,
              phoneNumber: sanitizedPhone,
              accountName: description || `${paymentMethod} Withdrawal`,
              isDefault: false
            }
          });
          finalMethodId = newMethod.methodId;
          logger.info('Payment method created for withdrawal:', { userId, methodId: finalMethodId, provider: paymentMethod });
        }
      } catch (error) {
        logger.error('Failed to create/find payment method:', {
          message: error.message,
          code: error.code,
          meta: error.meta,
          userId,
          provider: paymentMethod
        });
        if (error.code === 'P2002') {
          return res.status(400).json({ error: 'Payment method already exists' });
        }
        return res.status(500).json({ 
          error: 'Failed to process withdrawal',
          details: error.message 
        });
      }
    }

    if (!finalMethodId) {
      return res.status(400).json({ error: 'Payment method information is required' });
    }

    const result = await paymentProcessingService.initiateWithdrawal({
      userId,
      walletId,
      methodId: finalMethodId,
      amount: parseFloat(amount),
      metadata: { ip: req.ip, userAgent: req.get('user-agent'), description, withdrawalSource: normalizedSource },
      withdrawalSource: normalizedSource,
      role: req.user?.role
    });

    res.json(result);
  } catch (error) {
    logger.error('Withdrawal initiation error:', {
      message: error.message,
      stack: error.stack,
      code: error.code
    });
    res.status(400).json({ error: error.message });
  }
};

exports.getWithdrawalStatus = async (req, res) => {
  try {
    const { referenceNumber } = req.params;
    const userId = req.user?.userId || req.query.userId;

    const whereClause = { referenceNumber: referenceNumber };
    if (userId) {
      whereClause.userId = userId;
    }

    const result = await prisma.withdrawal.findFirst({
      where: whereClause,
      select: {
        withdrawalId: true,
        referenceNumber: true,
        amount: true,
        fee: true,
        totalDeducted: true,
        provider: true,
        status: true,
        requiresApproval: true,
        createdAt: true,
        failureReason: true,
      }
    });

    if (!result) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    res.json(result);
  } catch (error) {
    logger.error('Get withdrawal status error:', error);
    res.status(500).json({ error: 'Failed to get withdrawal status' });
  }
};

exports.addPaymentMethod = async (req, res) => {
  try {
    const { provider, phoneNumber, accountName } = req.body;
    const userId = req.user?.userId || req.body.userId;

    if (!provider || !phoneNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    const existingMethods = await prisma.paymentMethod.count({
      where: { userId: userId }
    });

    const result = await prisma.paymentMethod.create({
      data: {
        userId: userId,
        provider,
        phoneNumber: sanitizedPhone,
        accountName: accountName || null,
        isDefault: existingMethods === 0 // Set as default if it's the first method
      },
      select: {
        methodId: true,
        provider: true,
        phoneNumber: true,
        accountName: true,
        isDefault: true,
        isVerified: true,
      }
    });

    logger.info('Payment method added:', { userId, provider, methodId: result.methodId });
    res.json(result);
  } catch (error) {
    logger.error('Add payment method error:', error);

    if (error.code === 'P2002') { // Prisma unique constraint violation
      return res.status(400).json({ error: 'Payment method already exists' });
    }

    res.status(500).json({ error: 'Failed to add payment method' });
  }
};

exports.getPaymentMethods = async (req, res) => {
  try {
    const userId = req.user?.userId || req.query.userId;

    const result = await prisma.paymentMethod.findMany({
      where: { userId: userId, isActive: true },
      orderBy: [
        { isDefault: 'desc' },
        { createdAt: 'desc' }
      ],
      select: {
        methodId: true,
        provider: true,
        phoneNumber: true,
        accountName: true,
        isDefault: true,
        isVerified: true,
        isActive: true,
        createdAt: true,
      }
    });

    res.json(result);
  } catch (error) {
    logger.error('Get payment methods error:', error);
    res.status(500).json({ error: 'Failed to get payment methods' });
  }
};

exports.deletePaymentMethod = async (req, res) => {
  try {
    const { methodId } = req.params;
    const userId = req.user?.userId || req.body.userId;

    await prisma.paymentMethod.updateMany({
      where: { methodId: methodId, userId: userId },
      data: { isActive: false }
    });

    logger.info('Payment method deleted:', { userId, methodId });
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete payment method error:', error);
    res.status(500).json({ error: 'Failed to delete payment method' });
  }
};

exports.getTransactionHistory = async (req, res) => {
  try {
    const userId = req.user?.userId || req.query.userId;
    const { type, limit = 50, offset = 0 } = req.query;

    let transactions = [];
    const hasModel = (model) => model && typeof model.findMany === 'function';
    const mapTransferType = (transfer, direction) => {
      const metaType = transfer?.metadata?.type;
      if (metaType === 'season_prize') return 'prize';
      if (metaType === 'platform_fee') return 'platform_fee';
      if (metaType === 'season_refund') return 'refund';
      return direction === 'sent' ? 'transfer_sent' : 'transfer_received';
    };

    if (type === 'deposit' || type === 'deposits') {
      transactions = await prisma.deposit.findMany({
        where: { userId: userId },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
        select: {
          depositId: true,
          referenceNumber: true,
          amount: true,
          provider: true,
          status: true,
          createdAt: true,
          completedAt: true,
        }
      });
      transactions = transactions.map(t => ({ ...t, type: 'deposit', id: t.depositId, fee: null }));
    } else if (type === 'withdrawal' || type === 'withdrawals') {
      transactions = await prisma.withdrawal.findMany({
        where: { userId: userId },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
        select: {
          withdrawalId: true,
          referenceNumber: true,
          amount: true,
          fee: true,
          provider: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        }
      });
      transactions = transactions.map(t => ({ ...t, type: 'withdrawal', id: t.withdrawalId }));
    } else if (type === 'tournament_fee' || type === 'tournament_fees') {
      if (!hasModel(prisma.tournamentFee)) {
        logger.warn('Tournament fee model not available in payment-service prisma');
        return res.json([]);
      }
      transactions = await prisma.tournamentFee.findMany({
        where: { userId: userId },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
        select: {
          feeId: true,
          referenceNumber: true,
          amount: true,
          fee: true,
          tournamentId: true,
          seasonId: true,
          status: true,
          createdAt: true,
          processedAt: true,
        }
      });
      transactions = transactions.map(t => ({ ...t, type: 'tournament_fee', id: t.feeId }));
    } else if (type === 'transfer' || type === 'transfers') {
      if (!hasModel(prisma.walletTransfer)) {
        logger.warn('Wallet transfer model not available in payment-service prisma');
        return res.json([]);
      }
      const sentTransfers = await prisma.walletTransfer.findMany({
        where: { fromUserId: userId },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
        select: {
          transferId: true,
          fromUserId: true,
          toUserId: true,
          amount: true,
          fee: true,
          description: true,
          referenceNumber: true,
          status: true,
          createdAt: true,
          processedAt: true,
          metadata: true,
        }
      });
      const receivedTransfers = await prisma.walletTransfer.findMany({
        where: { toUserId: userId },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
        select: {
          transferId: true,
          fromUserId: true,
          toUserId: true,
          amount: true,
          fee: true,
          description: true,
          referenceNumber: true,
          status: true,
          createdAt: true,
          processedAt: true,
          metadata: true,
        }
      });
      transactions = [
        ...sentTransfers.map(t => ({
          ...t,
          type: mapTransferType(t, 'sent'),
          id: t.transferId,
          direction: 'sent'
        })),
        ...receivedTransfers.map(t => ({
          ...t,
          type: mapTransferType(t, 'received'),
          id: t.transferId,
          direction: 'received'
        }))
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    } else {
      const deposits = await prisma.deposit.findMany({
        where: { userId: userId },
        select: {
          depositId: true,
          referenceNumber: true,
          amount: true,
          provider: true,
          status: true,
          createdAt: true,
          completedAt: true,
        }
      });
      const withdrawals = await prisma.withdrawal.findMany({
        where: { userId: userId },
        select: {
          withdrawalId: true,
          referenceNumber: true,
          amount: true,
          fee: true,
          provider: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        }
      });
      const tournamentFees = hasModel(prisma.tournamentFee)
        ? await prisma.tournamentFee.findMany({
            where: { userId: userId },
            select: {
              feeId: true,
              referenceNumber: true,
              amount: true,
              fee: true,
              tournamentId: true,
              seasonId: true,
              status: true,
              createdAt: true,
              processedAt: true,
            }
          })
        : [];
      if (!hasModel(prisma.tournamentFee)) {
        logger.warn('Tournament fee model not available in payment-service prisma');
      }

      const sentTransfers = hasModel(prisma.walletTransfer)
        ? await prisma.walletTransfer.findMany({
            where: { fromUserId: userId },
            select: {
              transferId: true,
              fromUserId: true,
              toUserId: true,
              amount: true,
              fee: true,
              description: true,
              referenceNumber: true,
              status: true,
              createdAt: true,
              processedAt: true,
              metadata: true,
            }
          })
        : [];
      const receivedTransfers = hasModel(prisma.walletTransfer)
        ? await prisma.walletTransfer.findMany({
            where: { toUserId: userId },
            select: {
              transferId: true,
              fromUserId: true,
              toUserId: true,
              amount: true,
              fee: true,
              description: true,
              referenceNumber: true,
              status: true,
              createdAt: true,
              processedAt: true,
              metadata: true,
            }
          })
        : [];
      if (!hasModel(prisma.walletTransfer)) {
        logger.warn('Wallet transfer model not available in payment-service prisma');
      }

      transactions = [
        ...deposits.map(t => ({ ...t, type: 'deposit', id: t.depositId, fee: null })),
        ...withdrawals.map(t => ({ ...t, type: 'withdrawal', id: t.withdrawalId })),
        ...tournamentFees.map(t => ({ ...t, type: 'tournament_fee', id: t.feeId })),
        ...sentTransfers.map(t => ({
          ...t,
          type: mapTransferType(t, 'sent'),
          id: t.transferId,
          direction: 'sent'
        })),
        ...receivedTransfers.map(t => ({
          ...t,
          type: mapTransferType(t, 'received'),
          id: t.transferId,
          direction: 'received'
        }))
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    }

    res.json(transactions);
  } catch (error) {
    logger.error('Get transaction history error:', error);
    res.status(500).json({ error: 'Failed to get transaction history' });
  }
};

exports.listAdminTransactions = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const { type, status, limit = 50, offset = 0 } = req.query;
    const take = parseInt(limit, 10);
    const skip = parseInt(offset, 10);
    const hasModel = (model) => model && typeof model.findMany === 'function';

    if (type === 'deposit' || type === 'deposits') {
      const where = {};
      if (status) where.status = status;
      const [rows, total] = await Promise.all([
        prisma.deposit.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          skip,
          select: {
            depositId: true,
            userId: true,
            referenceNumber: true,
            amount: true,
            fee: true,
            provider: true,
            providerTid: true,
            phoneNumber: true,
            status: true,
            createdAt: true,
            completedAt: true,
            transactionMessage: true,
            externalReference: true,
            metadata: true,
            callbackData: true,
            approvedBy: true,
            approvedAt: true,
            failureReason: true,
            totalAmount: true
          }
        }),
        prisma.deposit.count({ where })
      ]);

      return res.json({
        success: true,
        data: {
          transactions: rows.map((row) => ({ ...row, type: 'deposit', id: row.depositId })),
          total
        }
      });
    }

    if (type === 'withdrawal' || type === 'withdrawals' || type === 'cashout' || type === 'cashouts') {
      const where = {};
      if (status) where.status = status;
      const [rows, total] = await Promise.all([
        prisma.withdrawal.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          skip,
          select: {
            withdrawalId: true,
            userId: true,
            referenceNumber: true,
            amount: true,
            fee: true,
            provider: true,
            phoneNumber: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            externalReference: true,
            metadata: true,
            failureReason: true,
            totalDeducted: true
          }
        }),
        prisma.withdrawal.count({ where })
      ]);

      return res.json({
        success: true,
        data: {
          transactions: rows.map((row) => ({ ...row, type: 'withdrawal', id: row.withdrawalId })),
          total
        }
      });
    }

    if (type === 'transfer' || type === 'transfers' || type === 'wallet_transfer') {
      if (!hasModel(prisma.walletTransfer)) {
        return res.json({ success: true, data: { transactions: [], total: 0 } });
      }
      const where = {};
      if (status) where.status = status;
      const [rows, total] = await Promise.all([
        prisma.walletTransfer.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take,
          skip
        }),
        prisma.walletTransfer.count({ where })
      ]);

      return res.json({
        success: true,
        data: {
          transactions: rows.map((row) => ({ ...row, type: 'wallet_transfer', id: row.transferId })),
          total
        }
      });
    }

    const depositWhere = {};
    const withdrawalWhere = {};
    if (status) {
      depositWhere.status = status;
      withdrawalWhere.status = status;
    }

    const [deposits, withdrawals, walletTransfers] = await Promise.all([
      prisma.deposit.findMany({
        where: depositWhere,
        orderBy: { createdAt: 'desc' },
        select: {
          depositId: true,
          userId: true,
          referenceNumber: true,
          amount: true,
          fee: true,
          provider: true,
          providerTid: true,
          phoneNumber: true,
          status: true,
          createdAt: true,
          completedAt: true,
          transactionMessage: true,
          externalReference: true,
          metadata: true,
          callbackData: true,
          approvedBy: true,
          approvedAt: true,
          failureReason: true,
          totalAmount: true
        }
      }),
      prisma.withdrawal.findMany({
        where: withdrawalWhere,
        orderBy: { createdAt: 'desc' },
        select: {
          withdrawalId: true,
          userId: true,
          referenceNumber: true,
          amount: true,
          fee: true,
          provider: true,
          phoneNumber: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          externalReference: true,
          metadata: true,
          failureReason: true,
          totalDeducted: true
        }
      }),
      hasModel(prisma.walletTransfer)
        ? prisma.walletTransfer.findMany({
            orderBy: { createdAt: 'desc' }
          })
        : Promise.resolve([])
    ]);

    const combined = [
      ...deposits.map((row) => ({ ...row, type: 'deposit', id: row.depositId, date: row.createdAt })),
      ...withdrawals.map((row) => ({ ...row, type: 'withdrawal', id: row.withdrawalId, date: row.createdAt })),
      ...walletTransfers.map((row) => ({ ...row, type: 'wallet_transfer', id: row.transferId, date: row.createdAt }))
    ]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(skip, skip + take)
      .map(({ date, ...rest }) => rest);

    res.json({
      success: true,
      data: {
        transactions: combined,
        total: deposits.length + withdrawals.length
      }
    });
  } catch (error) {
    logger.error('List admin transactions error:', error);
    res.status(500).json({ success: false, error: 'Failed to list transactions' });
  }
};

exports.getAdminStats = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [pendingDeposits, pendingWithdrawals, depositFees, withdrawalFees, totalDeposits, totalWithdrawals, completedDeposits, completedWithdrawals, failedDeposits, failedWithdrawals, completedDepositTotals, completedWithdrawalTotals, todayDepositTotals, todayWithdrawalTotals] = await Promise.all([
      prisma.deposit.count({ where: { status: 'pending_approval' } }),
      prisma.withdrawal.count({ where: { status: { in: ['pending', 'pending_approval'] } } }),
      prisma.deposit.aggregate({
        where: { status: 'completed' },
        _sum: { fee: true }
      }),
      prisma.withdrawal.aggregate({
        where: { status: { in: ['processing', 'completed', 'approved'] } },
        _sum: { fee: true }
      }),
      prisma.deposit.count(),
      prisma.withdrawal.count(),
      prisma.deposit.count({ where: { status: 'completed' } }),
      prisma.withdrawal.count({ where: { status: { in: ['processing', 'completed', 'approved'] } } }),
      prisma.deposit.count({ where: { status: 'failed' } }),
      prisma.withdrawal.count({ where: { status: { in: ['failed', 'cancelled', 'rejected'] } } }),
      prisma.deposit.aggregate({
        where: { status: 'completed' },
        _sum: { amount: true }
      }),
      prisma.withdrawal.aggregate({
        where: { status: { in: ['processing', 'completed', 'approved'] } },
        _sum: { amount: true }
      }),
      prisma.deposit.aggregate({
        where: { status: 'completed', createdAt: { gte: todayStart } },
        _sum: { amount: true }
      }),
      prisma.withdrawal.aggregate({
        where: { status: { in: ['processing', 'completed', 'approved'] }, createdAt: { gte: todayStart } },
        _sum: { amount: true }
      })
    ]);

    const depositFeeTotal = Number(depositFees?._sum?.fee || 0);
    const withdrawalFeeTotal = Number(withdrawalFees?._sum?.fee || 0);
    const completedDepositAmount = Number(completedDepositTotals?._sum?.amount || 0);
    const completedWithdrawalAmount = Number(completedWithdrawalTotals?._sum?.amount || 0);
    const todayDepositAmount = Number(todayDepositTotals?._sum?.amount || 0);
    const todayWithdrawalAmount = Number(todayWithdrawalTotals?._sum?.amount || 0);

    res.json({
      success: true,
      data: {
        pendingDeposits,
        pendingCashouts: pendingWithdrawals,
        transactionFees: depositFeeTotal + withdrawalFeeTotal,
        depositFeeTotal,
        withdrawalFeeTotal,
        totalDeposits,
        totalCashouts: totalWithdrawals,
        completedDeposits,
        completedCashouts: completedWithdrawals,
        failedDeposits,
        failedCashouts: failedWithdrawals,
        completedDepositAmount,
        completedCashoutAmount: completedWithdrawalAmount,
        todayDepositAmount,
        todayCashoutAmount: todayWithdrawalAmount
      }
    });
  } catch (error) {
    logger.error('Get admin payment stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch payment statistics' });
  }
};

exports.handleCallback = async (req, res) => {
  try {
    const { provider } = req.params;
    const payload = req.body;
    const signature = req.headers['x-signature'];
    const secret = process.env.WEBHOOK_SECRET;

    if (!signature) {
      return res.status(401).json({ error: 'Missing webhook signature' });
    }
    if (!secret) {
      logger.error('WEBHOOK_SECRET is not configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    const verifyPayload = req.rawBody ? req.rawBody.toString('utf8') : payload;
    const isValid = verifyWebhookSignature(verifyPayload, signature, secret);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    await paymentProcessingService.processDepositCallback({
      provider,
      payload,
      signature
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Callback handling error:', error);
    res.status(500).json({ error: 'Callback processing failed' });
  }
};

exports.calculateWithdrawalFee = async (req, res) => {
  try {
    const { amount } = req.query;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const fee = paymentProcessingService.calculateWithdrawalFee(parseFloat(amount));
    const total = parseFloat(amount) + parseFloat(fee);

    res.json({
      amount: parseFloat(amount),
      fee: parseFloat(fee),
      total
    });
  } catch (error) {
    logger.error('Calculate fee error:', error);
    res.status(500).json({ error: 'Failed to calculate fee' });
  }
};

exports.approveWithdrawal = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const { withdrawalId } = req.params;
    const { transactionMessage } = req.body;
    const adminId = req.user?.userId || req.body.adminId;

    // Update withdrawal status and add transaction message
    await prisma.withdrawal.update({
      where: { withdrawalId: withdrawalId },
      data: { 
        requiresApproval: false, 
        status: 'approved',
        transactionMessage: transactionMessage || null
      }
    });

    await paymentProcessingService.processWithdrawal(withdrawalId);

    await paymentProcessingService.logAudit({
      eventType: 'withdrawal_approved',
      userId: null,
      referenceId: withdrawalId,
      referenceType: 'withdrawal',
      amount: null,
      provider: null,
      status: 'approved',
      details: { adminId, transactionMessage }
    });

    logger.info('Withdrawal approved:', { withdrawalId, adminId });
    res.json({ success: true });
  } catch (error) {
    logger.error('Approve withdrawal error:', error);
    res.status(500).json({ error: 'Failed to approve withdrawal' });
  }
};

exports.rejectWithdrawal = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const { withdrawalId } = req.params;
    const { reason } = req.body;
    const adminId = req.user?.userId || req.body.adminId;

    const withdrawal = await prisma.withdrawal.findUnique({
      where: { withdrawalId: withdrawalId }
    });

    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    await prisma.withdrawal.update({
      where: { withdrawalId: withdrawalId },
      data: { status: 'failed', failureReason: reason || 'Rejected by admin' }
    });

    await paymentProcessingService.logAudit({
      eventType: 'withdrawal_rejected',
      userId: withdrawal.userId,
      referenceId: withdrawalId,
      referenceType: 'withdrawal',
      amount: withdrawal.amount,
      provider: withdrawal.provider,
      status: 'rejected',
      details: { adminId, reason }
    });

    logger.info('Withdrawal rejected:', { withdrawalId, adminId, reason });
    res.json({ success: true });
  } catch (error) {
    logger.error('Reject withdrawal error:', error);
    res.status(500).json({ error: 'Failed to reject withdrawal' });
  }
};

exports.listPendingDeposits = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { status = 'pending_approval', limit = 50, offset = 0 } = req.query;
    const where = status ? { status } : {};

    const [deposits, total] = await Promise.all([
      prisma.deposit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit, 10),
        skip: parseInt(offset, 10)
      }),
      prisma.deposit.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        deposits,
        pagination: {
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10),
          total
        }
      }
    });
  } catch (error) {
    logger.error('List pending deposits error:', error);
    res.status(500).json({ success: false, error: 'Failed to list deposits' });
  }
};

exports.listPendingWithdrawals = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { status = 'pending', limit = 50, offset = 0 } = req.query;
    const where = status ? { status } : {};

    const [withdrawals, total] = await Promise.all([
      prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit, 10),
        skip: parseInt(offset, 10)
      }),
      prisma.withdrawal.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        withdrawals,
        pagination: {
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10),
          total
        }
      }
    });
  } catch (error) {
    logger.error('List pending withdrawals error:', error);
    res.status(500).json({ success: false, error: 'Failed to list withdrawals' });
  }
};

exports.rejectDeposit = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const { depositId } = req.params;
    const { reason } = req.body;
    const adminId = req.user?.userId || req.body.adminId;

    const deposit = await prisma.deposit.findUnique({ where: { depositId } });
    if (!deposit) {
      return res.status(404).json({ error: 'Deposit not found' });
    }

    await prisma.deposit.update({
      where: { depositId },
      data: { status: 'rejected', failureReason: reason || 'Rejected by admin' }
    });

    await paymentProcessingService.logAudit({
      eventType: 'deposit_rejected',
      userId: deposit.userId,
      referenceId: depositId,
      referenceType: 'deposit',
      amount: deposit.amount,
      provider: deposit.provider,
      status: 'rejected',
      details: { adminId, reason }
    });

    logger.info('Deposit rejected:', { depositId, adminId, reason });
    res.json({ success: true });
  } catch (error) {
    logger.error('Reject deposit error:', error);
    res.status(500).json({ error: 'Failed to reject deposit' });
  }
};

exports.getAllProviders = async (req, res) => {
  try {
    const { getEnabledProviders } = require('../config/providers.js');
    const providers = getEnabledProviders();

    res.json({
      success: true,
      data: providers.map(p => ({
        code: p.code,
        name: p.name,
        minAmount: p.minAmount,
        maxAmount: p.maxAmount,
        fee: p.fee,
        lipaNumber: p.lipaNumber,
        instructions: p.instructions,
        depositFeePercentage: p.depositFeePercentage
      }))
    });
  } catch (error) {
    logger.error('Get providers error:', error);
    res.status(500).json({ error: 'Failed to get payment providers' });
  }
};

exports.getProviderInfo = async (req, res) => {
  try {
    const { code } = req.params;
    const { amount } = req.query;
    const { getProvider, getProviderInstructions, calculateDepositDetails } = require('../config/providers.js');

    const provider = getProvider(code);
    if (!provider || !provider.enabled) {
      return res.status(404).json({ error: 'Provider not found or disabled' });
    }

    const numericAmount = amount ? parseFloat(amount) : null;
    const calculation = numericAmount ? calculateDepositDetails(code, numericAmount) : null;
    const instructionAmount = calculation?.totalPayable ?? numericAmount;
    const instructions = instructionAmount ? getProviderInstructions(code, instructionAmount) : null;

    res.json({
      success: true,
      data: {
        code: provider.code,
        name: provider.name,
        lipaNumber: provider.lipaNumber,
        minAmount: provider.minAmount,
        maxAmount: provider.maxAmount,
        fee: provider.fee,
        depositFeePercentage: provider.depositFeePercentage,
        requestedAmount: calculation?.requestedAmount || numericAmount,
        feeAmount: calculation?.feeAmount,
        totalPayable: calculation?.totalPayable,
        instructions
      }
    });
  } catch (error) {
    logger.error('Get provider info error:', error);
    res.status(500).json({ error: 'Failed to get provider information' });
  }
};

exports.confirmDeposit = async (req, res) => {
  try {
    const { referenceNumber, transactionMessage } = req.body;
    const userId = req.user?.userId || req.body.userId;

    if (!referenceNumber || !transactionMessage) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await paymentProcessingService.confirmDeposit({
      referenceNumber,
      transactionMessage,
      userId
    });

    res.json(result);
  } catch (error) {
    logger.error('Deposit confirmation error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.approveDeposit = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const { depositId } = req.params;
    const { transactionMessage } = req.body;
    const adminId = req.user?.userId || req.body.adminId;

    if (!depositId) {
      return res.status(400).json({ error: 'Deposit ID required' });
    }

    const result = await paymentProcessingService.approveDeposit({
      depositId,
      adminId,
      transactionMessage
    });

    res.json(result);
  } catch (error) {
    logger.error('Deposit approval error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getDepositByTid = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const { tid } = req.query;

    if (!tid) {
      return res.status(400).json({ error: 'TID parameter is required' });
    }

    const normalizedTid = String(tid).toUpperCase().trim();

    let deposit = await prisma.deposit.findFirst({
      where: { providerTid: normalizedTid }
    });

    if (!deposit) {
      deposit = await prisma.deposit.findFirst({
        where: {
          transactionMessage: {
            contains: normalizedTid,
            mode: 'insensitive'
          }
        }
      });
    }

    if (!deposit) {
      return res.status(404).json({ error: 'Deposit not found for provided TID' });
    }

    res.json({ success: true, data: deposit });
  } catch (error) {
    logger.error('Get deposit by TID error:', error);
    res.status(500).json({ error: 'Failed to fetch deposit by TID' });
  }
};

exports.approveDepositByTid = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const { tid, transactionMessage } = req.body;
    const adminId = req.user?.userId || req.body.adminId;

    if (!tid) {
      return res.status(400).json({ error: 'TID is required' });
    }

    const normalizedTid = String(tid).toUpperCase().trim();

    let deposit = await prisma.deposit.findFirst({
      where: { providerTid: normalizedTid }
    });

    if (!deposit) {
      deposit = await prisma.deposit.findFirst({
        where: {
          transactionMessage: {
            contains: normalizedTid,
            mode: 'insensitive'
          }
        }
      });
    }

    if (!deposit) {
      return res.status(404).json({ error: 'Deposit not found for provided TID' });
    }

    if (!deposit.providerTid) {
      await prisma.deposit.update({
        where: { depositId: deposit.depositId },
        data: { providerTid: normalizedTid }
      });
    }

    const finalMessage = transactionMessage || deposit.transactionMessage || null;
    let tidValidation = null;
    try {
      tidValidation = await MobileMoneyMessageService.approveDepositWithTid(
        deposit.depositId,
        adminId,
        normalizedTid,
        finalMessage
      );
    } catch (validationError) {
      logger.warn({ err: validationError, tid: normalizedTid, depositId: deposit.depositId }, 'TID validation failed');
    }

    const result = await paymentProcessingService.approveDeposit({
      depositId: deposit.depositId,
      adminId,
      transactionMessage: finalMessage
    });

    res.json({
      success: true,
      data: result,
      depositId: deposit.depositId,
      tidValidation
    });
  } catch (error) {
    logger.error('Approve deposit by TID error:', error);
    res.status(400).json({ error: error.message || 'Failed to approve deposit by TID' });
  }
};

// TID-based approval endpoints

exports.storeSmsMessage = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    
    const { rawText, linkedDepositId } = req.body;
    
    if (!rawText) {
      return res.status(400).json({ error: 'SMS message text is required' });
    }

    const result = await MobileMoneyMessageService.storeMessage(rawText, linkedDepositId);
    res.json(result);
  } catch (error) {
    logger.error('Store SMS message error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.searchByTid = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    
    const { tid } = req.query;
    
    if (!tid) {
      return res.status(400).json({ error: 'TID parameter is required' });
    }

    const result = await MobileMoneyMessageService.searchByTid(tid);
    res.json(result);
  } catch (error) {
    logger.error('Search by TID error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.attachMessageToDeposit = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    
    const { depositId } = req.params;
    const { tid, messageId } = req.body;
    const adminId = req.user?.userId;

    if (!depositId) {
      return res.status(400).json({ error: 'Deposit ID is required' });
    }

    if (!tid && !messageId) {
      return res.status(400).json({ error: 'Either TID or message ID is required' });
    }

    let result;
    if (messageId) {
      result = await MobileMoneyMessageService.attachToDeposit(messageId, depositId, adminId);
    } else {
      result = await MobileMoneyMessageService.attachByTid(tid, depositId, adminId);
    }

    res.json(result);
  } catch (error) {
    logger.error('Attach message to deposit error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.approveDepositWithTid = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    
    const { depositId } = req.params;
    const { tid, transactionMessage } = req.body;
    const adminId = req.user?.userId;

    // First validate with TID
    const tidValidationResult = await MobileMoneyMessageService.approveDepositWithTid(
      depositId, 
      adminId, 
      tid, 
      transactionMessage
    );

    // Then proceed with normal approval process
    const approvalResult = await paymentProcessingService.approveDeposit({
      depositId,
      adminId,
      transactionMessage
    });

    res.json({
      success: true,
      data: approvalResult,
      tidValidation: tidValidationResult,
      message: 'Deposit approved with TID validation'
    });
  } catch (error) {
    logger.error('Approve deposit with TID error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.listSmsMessages = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    
    const options = {
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      status: req.query.status || null,
      provider: req.query.provider || null,
      tid: req.query.tid || null,
      hasLinkedDeposit: req.query.hasLinkedDeposit ? req.query.hasLinkedDeposit === 'true' : null
    };

    const result = await MobileMoneyMessageService.listMessages(options);
    res.json(result);
  } catch (error) {
    logger.error('List SMS messages error:', error);
    res.status(500).json({ error: 'Failed to list SMS messages' });
  }
};

exports.getSmsMessageStats = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    
    const result = await MobileMoneyMessageService.getMessageStats();
    res.json(result);
  } catch (error) {
    logger.error('Get SMS message stats error:', error);
    res.status(500).json({ error: 'Failed to get SMS message stats' });
  }
};
