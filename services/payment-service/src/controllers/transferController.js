const { prisma } = require('../config/db.js');
const { logger } = require('../utils/logger.js');
const axios = require('axios');

const WALLET_SERVICE_URL =
  process.env.WALLET_SERVICE_URL ||
  (process.env.API_GATEWAY_URL ? `${process.env.API_GATEWAY_URL}/api/wallet` : null) ||
  'http://localhost:8081/api/wallet';
const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL ||
  process.env.API_GATEWAY_URL ||
  'http://localhost:8081/api/auth';
const hasModel = (model) => model && typeof model.create === 'function';

const normalizePhoneNumber = (phoneNumber, countryCode = '+255') => {
  if (!phoneNumber) return phoneNumber;
  const cleaned = String(phoneNumber).replace(/\s+/g, '');
  if (cleaned.startsWith('0')) {
    return `${countryCode}${cleaned.substring(1)}`;
  }
  if (!cleaned.startsWith('+')) {
    return `${countryCode}${cleaned}`;
  }
  return cleaned;
};

exports.transferFunds = async (req, res) => {
  try {
    const { fromWalletId, toPhoneNumber, amount, description, userId } = req.body;

    if (!fromWalletId || !toPhoneNumber || !amount || !userId) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const normalizedPhoneNumber = normalizePhoneNumber(toPhoneNumber);
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    // Lookup recipient by phone number
    let recipient;
    try {
      const authResponse = await axios.get(
        `${AUTH_SERVICE_URL}/users/lookup/phone/${encodeURIComponent(normalizedPhoneNumber)}`,
        {
          headers: {
            'Authorization': req.headers.authorization
          },
          timeout: 10000
        }
      );
      recipient = authResponse.data?.data;
    } catch (error) {
      logger.error('Recipient lookup failed:', error);
      const status = error?.response?.status;
      const message =
        status === 404 ? 'Recipient not found' : 'Failed to reach auth service';
      return res.status(status || 502).json({ success: false, error: message });
    }

    if (!recipient?.userId) {
      return res.status(404).json({ success: false, error: 'Recipient not found' });
    }

    // Get recipient wallet
    let recipientWallet;
    try {
      const walletResponse = await axios.get(
        `${WALLET_SERVICE_URL}/owner/${recipient.userId}?type=player`,
        {
          timeout: 10000
        }
      );
      recipientWallet = walletResponse.data?.data;
    } catch (error) {
      logger.error('Recipient wallet lookup failed:', error);
      return res.status(404).json({ success: false, error: 'Recipient wallet not found' });
    }

    if (!recipientWallet) {
      return res.status(404).json({ success: false, error: 'Recipient wallet not found' });
    }

    // Prevent transferring to self
    if (fromWalletId === recipientWallet.walletId) {
      return res.status(400).json({ success: false, error: 'Cannot transfer to your own wallet' });
    }

    // Generate reference number
    const referenceNumber = `TXFR${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

    // Process transfer
    try {
      // Call wallet service to transfer funds
      await axios.post(`${WALLET_SERVICE_URL}/transfer`, {
        fromWalletId,
        toWalletId: recipientWallet.walletId,
        amount: parsedAmount,
        description: description || 'Wallet transfer'
      }, {
        headers: {
          'Authorization': req.headers.authorization,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      // Create wallet transfer transaction record
      let walletTransfer = null;
      if (hasModel(prisma.walletTransfer)) {
        walletTransfer = await prisma.walletTransfer.create({
          data: {
            fromUserId: userId,
            fromWalletId,
            toUserId: recipient.userId,
            toWalletId: recipientWallet.walletId,
            amount: parsedAmount,
            fee: 0, // No transaction fee for wallet transfers
            currency: 'TZS',
            description,
            referenceNumber,
            status: 'completed',
            processedAt: new Date(),
            metadata: {
              toPhoneNumber: normalizedPhoneNumber,
              ip: req.ip,
              userAgent: req.get('user-agent')
            }
          }
        });
      } else {
        logger.warn('walletTransfer model not available; transfer will not be recorded in payment DB');
      }

      // Log audit for sender
      await prisma.paymentAuditLog.create({
        data: {
          eventType: 'wallet_transfer_sent',
          userId,
          referenceId: walletTransfer?.transferId || null,
          referenceType: 'wallet_transfer',
          amount: parsedAmount,
          provider: null,
          status: 'completed',
          details: {
            toUserId: recipient.userId,
            toWalletId: recipientWallet.walletId,
            toPhoneNumber: normalizedPhoneNumber,
            referenceNumber,
            description,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
          }
        }
      });

      // Log audit for receiver
      await prisma.paymentAuditLog.create({
        data: {
          eventType: 'wallet_transfer_received',
          userId: recipient.userId,
          referenceId: walletTransfer?.transferId || null,
          referenceType: 'wallet_transfer',
          amount: parsedAmount,
          provider: null,
          status: 'completed',
          details: {
            fromUserId: userId,
            fromWalletId,
            referenceNumber,
            description,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
          }
        }
      });

      logger.info({ 
        fromUserId: userId, 
        toUserId: recipient.userId, 
        amount: parsedAmount, 
        referenceNumber 
      }, 'Wallet transfer completed');

      res.json({
        success: true,
        data: {
          transferId: walletTransfer?.transferId || referenceNumber,
          referenceNumber,
          amount: parsedAmount,
          fee: 0,
          status: 'completed',
          recipient: {
            userId: recipient.userId,
            phoneNumber: normalizedPhoneNumber
          }
        }
      });
    } catch (walletError) {
      logger.error('Wallet transfer failed:', {
        message: walletError?.message,
        status: walletError?.response?.status,
        data: walletError?.response?.data,
      });
      
      // Create failed transaction record
      if (hasModel(prisma.walletTransfer)) {
        await prisma.walletTransfer.create({
          data: {
            fromUserId: userId,
            fromWalletId,
            toUserId: recipient.userId,
            toWalletId: recipientWallet.walletId,
            amount: parsedAmount,
            fee: 0,
            currency: 'TZS',
            description,
            referenceNumber,
            status: 'failed',
            failureReason: walletError.response?.data?.error || walletError.message,
            processedAt: new Date(),
            metadata: {
              toPhoneNumber: normalizedPhoneNumber,
              ip: req.ip,
              userAgent: req.get('user-agent')
            }
          }
        });
      } else {
        logger.warn('walletTransfer model not available; failed transfer not recorded in payment DB');
      }

      const walletErrorMessage =
        walletError?.response?.data?.error ||
        walletError?.response?.data?.message ||
        walletError?.message ||
        'Failed to transfer funds';

      return res.status(400).json({
        success: false,
        error: walletErrorMessage
      });
    }
  } catch (error) {
    logger.error('Transfer funds error:', error);
    res.status(500).json({ success: false, error: 'Failed to process transfer' });
  }
};

exports.internalTransfer = async (req, res) => {
  try {
    const {
      fromWalletId,
      toWalletId,
      amount,
      description,
      metadata,
      fromUserId,
      toUserId,
      referenceNumber,
      idempotencyKey
    } = req.body;

    if (!fromWalletId || !toWalletId || !amount) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    if (fromWalletId === toWalletId) {
      return res.status(400).json({ success: false, error: 'Cannot transfer to the same wallet' });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const effectiveReference =
      referenceNumber ||
      (idempotencyKey ? `INTERNAL-${idempotencyKey}` : `INTXFR${Date.now()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`);

    try {
      await axios.post(
        `${WALLET_SERVICE_URL}/transfer`,
        {
          fromWalletId,
          toWalletId,
          amount: parsedAmount,
          description: description || 'Internal transfer',
          metadata,
          idempotencyKey
        },
        {
          headers: {
            'Authorization': req.headers.authorization,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      let walletTransfer = null;
      if (hasModel(prisma.walletTransfer)) {
        walletTransfer = await prisma.walletTransfer.create({
          data: {
            fromUserId: fromUserId || req.user?.userId || null,
            fromWalletId,
            toUserId: toUserId || null,
            toWalletId,
            amount: parsedAmount,
            fee: 0,
            currency: 'TZS',
            description,
            referenceNumber: effectiveReference,
            status: 'completed',
            processedAt: new Date(),
            metadata: {
              ...(metadata || {}),
              idempotencyKey: idempotencyKey || null,
              source: 'internal'
            }
          }
        });
      } else {
        logger.warn('walletTransfer model not available; transfer will not be recorded in payment DB');
      }

      logger.info({
        fromWalletId,
        toWalletId,
        amount: parsedAmount,
        referenceNumber: effectiveReference
      }, 'Internal wallet transfer completed');

      res.json({
        success: true,
        data: {
          transferId: walletTransfer?.transferId || effectiveReference,
          referenceNumber: effectiveReference,
          amount: parsedAmount,
          fee: 0,
          status: 'completed'
        }
      });
    } catch (walletError) {
      logger.error('Internal wallet transfer failed:', {
        message: walletError?.message,
        status: walletError?.response?.status,
        data: walletError?.response?.data,
      });

      if (hasModel(prisma.walletTransfer)) {
        await prisma.walletTransfer.create({
          data: {
            fromUserId: fromUserId || req.user?.userId || null,
            fromWalletId,
            toUserId: toUserId || null,
            toWalletId,
            amount: parsedAmount,
            fee: 0,
            currency: 'TZS',
            description,
            referenceNumber: effectiveReference,
            status: 'failed',
            failureReason: walletError.response?.data?.error || walletError.message,
            processedAt: new Date(),
            metadata: {
              ...(metadata || {}),
              idempotencyKey: idempotencyKey || null,
              source: 'internal'
            }
          }
        });
      } else {
        logger.warn('walletTransfer model not available; failed transfer not recorded in payment DB');
      }

      const walletErrorMessage =
        walletError?.response?.data?.error ||
        walletError?.response?.data?.message ||
        walletError?.message ||
        'Failed to transfer funds';

      return res.status(400).json({
        success: false,
        error: walletErrorMessage
      });
    }
  } catch (error) {
    logger.error('Internal transfer error:', error);
    res.status(500).json({ success: false, error: 'Failed to process transfer' });
  }
};

exports.getTransfers = async (req, res) => {
  try {
    const userId = req.user?.userId || req.query.userId;
    const { type, limit = 50, offset = 0 } = req.query;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    if (!hasModel(prisma.walletTransfer)) {
      logger.warn('walletTransfer model not available; returning empty transfers list');
      return res.json({ success: true, data: [] });
    }

    let transfers = [];

    if (type === 'sent' || !type) {
      const sentTransfers = await prisma.walletTransfer.findMany({
        where: { fromUserId: userId },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
        select: {
          transferId: true,
          fromUserId: true,
          fromWalletId: true,
          toUserId: true,
          toWalletId: true,
          amount: true,
          fee: true,
          currency: true,
          description: true,
          referenceNumber: true,
          status: true,
          processedAt: true,
          createdAt: true,
          metadata: true
        }
      });
      transfers = [...transfers, ...sentTransfers.map(t => ({ ...t, direction: 'sent' }))];
    }

    if (type === 'received' || !type) {
      const receivedTransfers = await prisma.walletTransfer.findMany({
        where: { toUserId: userId },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
        select: {
          transferId: true,
          fromUserId: true,
          fromWalletId: true,
          toUserId: true,
          toWalletId: true,
          amount: true,
          fee: true,
          currency: true,
          description: true,
          referenceNumber: true,
          status: true,
          processedAt: true,
          createdAt: true,
          metadata: true
        }
      });
      transfers = [...transfers, ...receivedTransfers.map(t => ({ ...t, direction: 'received' }))];
    }

    // Sort by date
    transfers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      success: true,
      data: transfers
    });
  } catch (error) {
    logger.error('Get transfers error:', error);
    res.status(500).json({ success: false, error: 'Failed to get transfers' });
  }
};

exports.getTransfer = async (req, res) => {
  try {
    const { transferId } = req.params;
    const userId = req.user?.userId;

    if (!hasModel(prisma.walletTransfer)) {
      logger.warn('walletTransfer model not available; transfer lookup disabled');
      return res.status(404).json({ success: false, error: 'Transfer not found' });
    }

    const transfer = await prisma.walletTransfer.findUnique({
      where: { transferId }
    });

    if (!transfer) {
      return res.status(404).json({ success: false, error: 'Transfer not found' });
    }

    // Only allow access to sender or receiver
    if (transfer.fromUserId !== userId && transfer.toUserId !== userId) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    res.json({
      success: true,
      data: transfer
    });
  } catch (error) {
    logger.error('Get transfer error:', error);
    res.status(500).json({ success: false, error: 'Failed to get transfer' });
  }
};
