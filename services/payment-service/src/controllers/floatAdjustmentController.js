const { prisma } = require('../config/db.js');
const { logger } = require('../utils/logger.js');
const axios = require('axios');
const { publishEvent, Topics } = require('../../../../shared/events');

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002';

const HIGH_LEVEL_ROLES = new Set(['director', 'manager']);
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
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  return true;
};

exports.requestFloatAdjustment = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { walletId, type, amount, reason } = req.body;

    if (!walletId || !type || !amount || !reason) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: walletId, type, amount, reason' 
      });
    }

    if (!['credit', 'debit'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Type must be either "credit" or "debit"' 
      });
    }

    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Amount must be greater than 0' 
      });
    }

    // Check if wallet exists
    try {
      await axios.get(`${WALLET_SERVICE_URL}/${walletId}`, { timeout: 5000 });
    } catch (error) {
      return res.status(404).json({ 
        success: false, 
        error: 'Wallet not found' 
      });
    }

    // Create float adjustment request
    const request = await prisma.floatAdjustmentRequest.create({
      data: {
        walletId,
        requestedBy: userId,
        type,
        amount: parseFloat(amount),
        reason,
        status: 'PENDING'
      },
      include: {
        approvals: true
      }
    });

    logger.info({
      requestId: request.requestId,
      userId,
      walletId,
      type,
      amount
    }, 'Float adjustment request created');

    // Publish Kafka event
    await publishEvent(Topics.FLOAT_ADJUSTMENT_REQUESTED, {
      requestId: request.requestId,
      walletId: request.walletId,
      requestedBy: userId,
      type: request.type,
      amount: parseFloat(request.amount),
      reason: request.reason,
      status: request.status,
      createdAt: request.createdAt
    }, request.requestId);

    res.status(201).json({
      success: true,
      data: {
        requestId: request.requestId,
        walletId: request.walletId,
        type: request.type,
        amount: parseFloat(request.amount),
        reason: request.reason,
        status: request.status,
        createdAt: request.createdAt,
        approvals: request.approvals
      },
      message: 'Float adjustment request submitted. Requires approval from Director and Manager.'
    });
  } catch (error) {
    logger.error('Request float adjustment error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create float adjustment request' 
    });
  }
};

exports.approveFloatAdjustment = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { requestId } = req.params;
    const userId = req.user.userId;
    const userRole = req.user.role;
    const { comments } = req.body;

    if (!HIGH_LEVEL_ROLES.has(userRole)) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only Director or Manager can approve float adjustments' 
      });
    }

    const request = await prisma.floatAdjustmentRequest.findUnique({
      where: { requestId },
      include: { approvals: true }
    });

    if (!request) {
      return res.status(404).json({ 
        success: false, 
        error: 'Float adjustment request not found' 
      });
    }

    if (request.status !== 'PENDING') {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot approve request with status: ${request.status}` 
      });
    }

    // Check if user already approved
    const existingApproval = request.approvals.find(
      (a) => a.approvedBy === userId
    );

    if (existingApproval) {
      return res.status(400).json({ 
        success: false, 
        error: 'You have already approved this request' 
      });
    }

    // Create approval
    await prisma.floatApproval.create({
      data: {
        requestId,
        approvedBy: userId,
        approverRole: userRole,
        comments
      }
    });

    // Refresh request to check if it has 2 approvals
    const updatedRequest = await prisma.floatAdjustmentRequest.findUnique({
      where: { requestId },
      include: { approvals: true }
    });

    const approvals = updatedRequest.approvals;

    // Check if we have at least 2 approvals from different high-level roles
    const uniqueApproverRoles = new Set(approvals.map((a) => a.approverRole));
    const hasDirectorApproval = uniqueApproverRoles.has('director');
    const hasManagerApproval = uniqueApproverRoles.has('manager');

    if (hasDirectorApproval && hasManagerApproval && approvals.length >= 2) {
      // Process float adjustment
      try {
        if (request.type === 'credit') {
          await axios.post(
            `${WALLET_SERVICE_URL}/credit`,
            {
              walletId: request.walletId,
              amount: parseFloat(request.amount),
              description: `Float adjustment: ${request.reason}`
            },
            { timeout: 10000 }
          );
        } else {
          await axios.post(
            `${WALLET_SERVICE_URL}/debit`,
            {
              walletId: request.walletId,
              amount: parseFloat(request.amount),
              description: `Float adjustment: ${request.reason}`
            },
            { timeout: 10000 }
          );
        }

        // Update request as approved and processed
        await prisma.floatAdjustmentRequest.update({
          where: { requestId },
          data: {
            status: 'APPROVED',
            processedAt: new Date()
          }
        });

        // Publish Kafka event
        await publishEvent(Topics.FLOAT_ADJUSTMENT_APPROVED, {
          requestId,
          walletId: request.walletId,
          type: request.type,
          amount: parseFloat(request.amount),
          approvers: approvals.map((a) => ({ id: a.approvedBy, role: a.approverRole })),
          approvedAt: new Date()
        }, requestId);

        logger.info({
          requestId,
          walletId: request.walletId,
          type: request.type,
          amount: parseFloat(request.amount),
          approvers: approvals.map((a) => ({ id: a.approvedBy, role: a.approverRole }))
        }, 'Float adjustment processed');

        return res.json({
          success: true,
          data: {
            requestId,
            status: 'APPROVED',
            message: 'Float adjustment approved and processed'
          }
        });
      } catch (error) {
        logger.error('Failed to process float adjustment:', error);
        return res.status(500).json({
          success: false,
          error: 'Failed to process float adjustment'
        });
      }
    } else {
      // Still waiting for more approvals
      const missingApprovals = [];
      if (!hasDirectorApproval) missingApprovals.push('Director');
      if (!hasManagerApproval) missingApprovals.push('Manager');

      return res.json({
        success: true,
        data: {
          requestId,
          status: 'PENDING',
          approvals: approvals.length,
          message: `Approval recorded. Still waiting for: ${missingApprovals.join(' and ')}`
        }
      });
    }
  } catch (error) {
    logger.error('Approve float adjustment error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to approve float adjustment' 
    });
  }
};

exports.rejectFloatAdjustment = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { requestId } = req.params;
    const userId = req.user.userId;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ 
        success: false, 
        error: 'Rejection reason is required' 
      });
    }

    const request = await prisma.floatAdjustmentRequest.findUnique({
      where: { requestId }
    });

    if (!request) {
      return res.status(404).json({ 
        success: false, 
        error: 'Float adjustment request not found' 
      });
    }

    if (request.status !== 'PENDING') {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot reject request with status: ${request.status}` 
      });
    }

    await prisma.floatAdjustmentRequest.update({
      where: { requestId },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
        processedAt: new Date()
      }
    });

    // Publish Kafka event
    await publishEvent(Topics.FLOAT_ADJUSTMENT_REJECTED, {
      requestId,
      walletId: request.walletId,
      type: request.type,
      amount: parseFloat(request.amount),
      rejectedBy: userId,
      rejectionReason: reason,
      rejectedAt: new Date()
    }, requestId);

    logger.info({
      requestId,
      rejectedBy: userId,
      reason
    }, 'Float adjustment rejected');

    res.json({
      success: true,
      data: {
        requestId,
        status: 'REJECTED',
        reason
      },
      message: 'Float adjustment request rejected'
    });
  } catch (error) {
    logger.error('Reject float adjustment error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to reject float adjustment' 
    });
  }
};

exports.getFloatAdjustmentRequests = async (req, res) => {
  try {
    const userId = req.user.userId;
    const userRole = req.user.role;
    const isAdmin = ADMIN_ROLES.has(userRole);

    let whereClause = {};

    // If not admin, only show own requests
    if (!isAdmin) {
      whereClause = { requestedBy: userId };
    }

    const { status, walletId, limit = 50, offset = 0 } = req.query;

    if (status) {
      whereClause.status = status.toUpperCase();
    }

    if (walletId) {
      whereClause.walletId = walletId;
    }

    const requests = await prisma.floatAdjustmentRequest.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: {
        approvals: {
          orderBy: { approvedAt: 'desc' }
        }
      }
    });

    const total = await prisma.floatAdjustmentRequest.count({ where: whereClause });

    res.json({
      success: true,
      data: {
        requests,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    logger.error('Get float adjustment requests error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get float adjustment requests' 
    });
  }
};

exports.getFloatAdjustmentById = async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.user.userId;
    const userRole = req.user.role;
    const isAdmin = ADMIN_ROLES.has(userRole);

    const request = await prisma.floatAdjustmentRequest.findUnique({
      where: { requestId },
      include: {
        approvals: {
          orderBy: { approvedAt: 'desc' }
        }
      }
    });

    if (!request) {
      return res.status(404).json({ 
        success: false, 
        error: 'Float adjustment request not found' 
      });
    }

    // If not admin and not requester, deny access
    if (!isAdmin && request.requestedBy !== userId) {
      return res.status(403).json({ 
        success: false, 
        error: 'Forbidden' 
      });
    }

    res.json({
      success: true,
      data: request
    });
  } catch (error) {
    logger.error('Get float adjustment by ID error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get float adjustment request' 
    });
  }
};
