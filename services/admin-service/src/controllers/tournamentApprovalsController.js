const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { publishEvent, Topics } = require('../../../../shared/events');
const { enqueueNotification } = require('../../../../shared/utils/notificationHelper');
const { randomUUID } = require('crypto');

const RESOURCE_TYPE = 'tournament';

const REQUEST_ROLES = new Set(['super_admin', 'admin', 'game_master']);
const APPROVER_ROLES = new Set(['manager', 'director', 'super_admin']);

const BYPASS_APPROVAL_ROLES = new Set(
  (process.env.TOURNAMENT_COMMAND_APPROVAL_BYPASS_ROLES || 'super_admin')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const BYPASS_ALLOW_CANCEL =
  String(process.env.TOURNAMENT_BYPASS_ALLOW_CANCEL || 'false').toLowerCase() ===
  'true';

const APPROVER_NOTIFY_ROLES = ['manager', 'director'];

function assertRoleAllowed(set, role, errorMessage) {
  if (!role || !set.has(role)) {
    const err = new Error(errorMessage);
    err.statusCode = 403;
    throw err;
  }
}

async function notifyApprovers({ title, message, data }) {
  const approvers = await prisma.adminUser.findMany({
    where: { role: { in: APPROVER_NOTIFY_ROLES }, isActive: true },
    select: { userId: true, role: true }
  });

  await Promise.all(
    approvers.map((u) =>
      enqueueNotification({
        userId: u.userId,
        channel: 'in_app',
        type: 'approval',
        title,
        message,
        data: data || {}
      }).catch((err) => {
        logger.error({ err, userId: u.userId }, '[admin] Failed to enqueue approval notification');
      })
    )
  );
}

async function createApprovalRequest({ action, payload, requester }) {
  const commandId = randomUUID();

  return prisma.approvalRequest.create({
    data: {
      resourceType: RESOURCE_TYPE,
      resourceId: payload?.tournamentId || null,
      action,
      payload,
      status: 'pending',
      requestedByUserId: requester.userId,
      requestedByRole: requester.role,
      commandId
    }
  });
}

async function maybeAutoApprove(approval, bypassApproval, bypassReason) {
  if (!bypassApproval) {
    return approval;
  }

  if (!BYPASS_APPROVAL_ROLES.has(approval.requestedByRole)) {
    return approval;
  }

  // Guardrail: destructive actions should not be bypassable by default.
  if (approval.action === 'CANCEL' && !BYPASS_ALLOW_CANCEL) {
    const err = new Error('Bypass is not allowed for CANCEL actions');
    err.statusCode = 403;
    throw err;
  }

  if (!bypassReason || String(bypassReason).trim().length < 5) {
    const err = new Error('bypassReason is required (min 5 characters) when bypassApproval is true');
    err.statusCode = 400;
    throw err;
  }

  return prisma.approvalRequest.update({
    where: { approvalId: approval.approvalId },
    data: {
      status: 'approved',
      approvedByUserId: approval.requestedByUserId,
      approvedByRole: approval.requestedByRole,
      approvedAt: new Date(),
      decisionNote: `bypass: ${bypassReason}`,
      bypassRequested: true,
      bypassReason: String(bypassReason)
    }
  });
}

async function dispatchTournamentCommand({ approval, actor }) {
  await publishEvent(
    Topics.TOURNAMENT_COMMAND,
    {
      commandId: approval.commandId,
      action: approval.action,
      data: approval.payload,
      actor
    },
    approval.commandId
  );
}

exports.requestCreateTournament = async (req, res) => {
  try {
    const requester = { userId: req.user.userId, role: req.user.role };
    assertRoleAllowed(REQUEST_ROLES, requester.role, 'Insufficient role to request tournament creation');

    const { name, description, entryFee, maxPlayers, seasonDuration, bypassApproval, bypassReason } = req.body;
    if (!name || entryFee === undefined) {
      return res.status(400).json({ success: false, error: 'name and entryFee are required' });
    }

    const approval = await createApprovalRequest({
      action: 'CREATE',
      payload: { name, description, entryFee, maxPlayers, seasonDuration },
      requester
    });

    const finalized = await maybeAutoApprove(approval, !!bypassApproval, bypassReason);
    if (finalized.status === 'approved') {
      await dispatchTournamentCommand({
        approval: finalized,
        actor: requester
      });

      await notifyApprovers({
        title: 'Tournament bypass executed',
        message: `A tournament CREATE command was bypass-approved by ${requester.role} (${requester.userId}). Reason: ${finalized.bypassReason}`,
        data: { approvalId: finalized.approvalId, commandId: finalized.commandId, action: 'CREATE' }
      });
    } else {
      await notifyApprovers({
        title: 'Tournament approval requested',
        message: `Tournament CREATE requested by ${requester.role} (${requester.userId})`,
        data: { approvalId: finalized.approvalId, commandId: finalized.commandId, action: 'CREATE' }
      });
    }

    res.status(201).json({ success: true, data: finalized });
  } catch (err) {
    logger.error({ err }, '[admin] requestCreateTournament failed');
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Failed to request tournament creation' });
  }
};

exports.requestTournamentAction = async (req, res) => {
  try {
    const requester = { userId: req.user.userId, role: req.user.role };
    assertRoleAllowed(REQUEST_ROLES, requester.role, 'Insufficient role to request tournament actions');

    const { tournamentId } = req.params;
    const { action, reason, bypassApproval, bypassReason } = req.body;

    if (!tournamentId || !action) {
      return res.status(400).json({ success: false, error: 'tournamentId and action are required' });
    }

    if (!['START', 'STOP', 'CANCEL'].includes(action)) {
      return res.status(400).json({ success: false, error: 'action must be START, STOP, or CANCEL' });
    }

    const approval = await createApprovalRequest({
      action,
      payload: { tournamentId, reason: reason || null },
      requester
    });

    const finalized = await maybeAutoApprove(approval, !!bypassApproval, bypassReason);
    if (finalized.status === 'approved') {
      await dispatchTournamentCommand({
        approval: finalized,
        actor: requester
      });

      await notifyApprovers({
        title: 'Tournament bypass executed',
        message: `A tournament ${action} command was bypass-approved by ${requester.role} (${requester.userId}). Reason: ${finalized.bypassReason}`,
        data: { approvalId: finalized.approvalId, commandId: finalized.commandId, action, tournamentId }
      });
    } else {
      await notifyApprovers({
        title: 'Tournament approval requested',
        message: `Tournament ${action} requested by ${requester.role} (${requester.userId})`,
        data: { approvalId: finalized.approvalId, commandId: finalized.commandId, action, tournamentId }
      });
    }

    res.status(201).json({ success: true, data: finalized });
  } catch (err) {
    logger.error({ err }, '[admin] requestTournamentAction failed');
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Failed to request tournament action' });
  }
};

exports.listApprovals = async (req, res) => {
  try {
    const { status = 'pending', limit = 50, offset = 0, resourceType = RESOURCE_TYPE } = req.query;

    const approvals = await prisma.approvalRequest.findMany({
      where: { status, resourceType },
      orderBy: { requestedAt: 'desc' },
      take: Number(limit),
      skip: Number(offset)
    });

    res.json({ success: true, data: approvals });
  } catch (err) {
    logger.error({ err }, '[admin] listApprovals failed');
    res.status(500).json({ success: false, error: 'Failed to list approvals' });
  }
};

exports.approve = async (req, res) => {
  try {
    const approver = { userId: req.user.userId, role: req.user.role };
    assertRoleAllowed(APPROVER_ROLES, approver.role, 'Insufficient role to approve');

    const { approvalId } = req.params;
    const { note } = req.body;

    const existing = await prisma.approvalRequest.findUnique({ where: { approvalId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Approval request not found' });
    }
    if (existing.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Approval is already ${existing.status}` });
    }

    const approved = await prisma.approvalRequest.update({
      where: { approvalId },
      data: {
        status: 'approved',
        approvedByUserId: approver.userId,
        approvedByRole: approver.role,
        approvedAt: new Date(),
        decisionNote: note || null
      }
    });

    await dispatchTournamentCommand({
      approval: approved,
      actor: approver
    });

    res.json({ success: true, data: approved });
  } catch (err) {
    logger.error({ err }, '[admin] approve failed');
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Failed to approve' });
  }
};

exports.reject = async (req, res) => {
  try {
    const approver = { userId: req.user.userId, role: req.user.role };
    assertRoleAllowed(APPROVER_ROLES, approver.role, 'Insufficient role to reject');

    const { approvalId } = req.params;
    const { note } = req.body;

    const existing = await prisma.approvalRequest.findUnique({ where: { approvalId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Approval request not found' });
    }
    if (existing.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Approval is already ${existing.status}` });
    }

    const rejected = await prisma.approvalRequest.update({
      where: { approvalId },
      data: {
        status: 'rejected',
        rejectedByUserId: approver.userId,
        rejectedByRole: approver.role,
        rejectedAt: new Date(),
        decisionNote: note || null
      }
    });

    res.json({ success: true, data: rejected });
  } catch (err) {
    logger.error({ err }, '[admin] reject failed');
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Failed to reject' });
  }
};
