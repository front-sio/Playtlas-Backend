const { prisma } = require('../config/db.js');
const { logger } = require('../utils/logger.js');
const axios = require('axios');

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:3000';

exports.payTournamentFee = async (req, res) => {
  try {
    const { playerWalletId, amount, tournamentId, seasonId, userId } = req.body;

    if (!playerWalletId || !amount || !tournamentId || !seasonId || !userId) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    // Generate reference number
    const referenceNumber = `TFEE${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

    // Process the tournament fee payment
    try {
      // Call wallet service to transfer funds
      await axios.post(`${WALLET_SERVICE_URL}/pay-tournament-fee`, {
        playerWalletId,
        amount: parsedAmount,
        tournamentId,
        seasonId
      }, {
        headers: {
          'Authorization': req.headers.authorization,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      // Create tournament fee transaction record
      const tournamentFee = await prisma.tournamentFee.create({
        data: {
          userId,
          walletId: playerWalletId,
          tournamentId,
          seasonId,
          amount: parsedAmount,
          fee: 0, // No transaction fee for tournament entries
          currency: 'TZS',
          referenceNumber,
          status: 'completed',
          processedAt: new Date(),
          metadata: {
            ip: req.ip,
            userAgent: req.get('user-agent')
          }
        }
      });

      // Log audit
      await prisma.paymentAuditLog.create({
        data: {
          eventType: 'tournament_fee_paid',
          userId,
          referenceId: tournamentFee.feeId,
          referenceType: 'tournament_fee',
          amount: parsedAmount,
          provider: null,
          status: 'completed',
          details: {
            tournamentId,
            seasonId,
            referenceNumber
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent')
        }
      });

      logger.info({ userId, tournamentId, seasonId, amount: parsedAmount, referenceNumber }, 'Tournament fee paid');

      res.json({
        success: true,
        data: {
          feeId: tournamentFee.feeId,
          referenceNumber,
          amount: parsedAmount,
          fee: 0,
          status: 'completed'
        }
      });
    } catch (walletError) {
      logger.error('Tournament fee wallet transfer failed:', walletError);
      
      // Create failed transaction record
      await prisma.tournamentFee.create({
        data: {
          userId,
          walletId: playerWalletId,
          tournamentId,
          seasonId,
          amount: parsedAmount,
          fee: 0,
          currency: 'TZS',
          referenceNumber,
          status: 'failed',
          failureReason: walletError.response?.data?.error || walletError.message,
          processedAt: new Date(),
          metadata: {
            ip: req.ip,
            userAgent: req.get('user-agent')
          }
        }
      });

      return res.status(400).json({ 
        success: false, 
        error: walletError.response?.data?.error || 'Failed to pay tournament fee' 
      });
    }
  } catch (error) {
    logger.error('Pay tournament fee error:', error);
    res.status(500).json({ success: false, error: 'Failed to process tournament fee' });
  }
};

exports.getTournamentFees = async (req, res) => {
  try {
    const userId = req.user?.userId || req.query.userId;
    const { tournamentId, seasonId, limit = 50, offset = 0 } = req.query;

    const where = {};
    if (userId) where.userId = userId;
    if (tournamentId) where.tournamentId = tournamentId;
    if (seasonId) where.seasonId = seasonId;

    const tournamentFees = await prisma.tournamentFee.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      select: {
        feeId: true,
        userId: true,
        walletId: true,
        tournamentId: true,
        seasonId: true,
        amount: true,
        fee: true,
        currency: true,
        referenceNumber: true,
        status: true,
        processedAt: true,
        createdAt: true
      }
    });

    res.json({
      success: true,
      data: tournamentFees
    });
  } catch (error) {
    logger.error('Get tournament fees error:', error);
    res.status(500).json({ success: false, error: 'Failed to get tournament fees' });
  }
};

exports.refundTournamentFee = async (req, res) => {
  try {
    const { feeId } = req.params;
    const { reason } = req.body;

    const tournamentFee = await prisma.tournamentFee.findUnique({
      where: { feeId }
    });

    if (!tournamentFee) {
      return res.status(404).json({ success: false, error: 'Tournament fee not found' });
    }

    if (tournamentFee.status !== 'completed') {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot refund tournament fee with status: ${tournamentFee.status}` 
      });
    }

    // Refund the amount back to player wallet
    try {
      await axios.post(`${WALLET_SERVICE_URL}/credit`, {
        walletId: tournamentFee.walletId,
        amount: tournamentFee.amount,
        description: `Tournament fee refund: ${reason || 'Tournament cancelled'}`
      }, {
        timeout: 10000
      });

      // Update tournament fee status
      await prisma.tournamentFee.update({
        where: { feeId },
        data: {
          status: 'refunded',
          metadata: {
            ...tournamentFee.metadata,
            refundedAt: new Date(),
            refundReason: reason
          }
        }
      });

      logger.info({ feeId, userId: tournamentFee.userId, amount: tournamentFee.amount }, 'Tournament fee refunded');

      res.json({
        success: true,
        message: 'Tournament fee refunded successfully'
      });
    } catch (walletError) {
      logger.error('Tournament fee refund failed:', walletError);
      return res.status(400).json({ 
        success: false, 
        error: 'Failed to refund tournament fee' 
      });
    }
  } catch (error) {
    logger.error('Refund tournament fee error:', error);
    res.status(500).json({ success: false, error: 'Failed to refund tournament fee' });
  }
};
