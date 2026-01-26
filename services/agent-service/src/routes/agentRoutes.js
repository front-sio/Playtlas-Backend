const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole, requireAnyRole } = require('../middlewares/roleAuth');
const agentController = require('../controllers/agentController');
const adminPaymentsRoutes = require('../controllers/AdminPaymentsController');

router.get('/me', authMiddleware, requireRole('agent'), agentController.getProfile);
router.post('/players/register', authMiddleware, requireRole('agent'), agentController.registerPlayer);
router.get('/players', authMiddleware, requireRole('agent'), agentController.listPlayers);
router.get('/transfer/lookup/phone/:phoneNumber', authMiddleware, requireRole('agent'), agentController.lookupRecipientByPhone);
router.post('/transfer', authMiddleware, requireRole('agent'), agentController.transferFloat);
router.get('/earnings', authMiddleware, requireRole('agent'), agentController.listEarnings);
router.get('/matches', authMiddleware, requireRole('agent'), agentController.listAssignedMatches);
router.post(
  '/admin/agents',
  authMiddleware,
  requireAnyRole(['admin', 'super_admin', 'superuser', 'superadmin', 'manager', 'director', 'staff']),
  agentController.createAgentProfile
);
router.get(
  '/admin/agents',
  authMiddleware,
  requireAnyRole(['admin', 'super_admin', 'superuser', 'superadmin', 'manager', 'director', 'staff']),
  agentController.listAgentsAdmin
);
router.get(
  '/admin/agents/:agentId/players',
  authMiddleware,
  requireAnyRole(['admin', 'super_admin', 'superuser', 'superadmin', 'manager', 'director', 'staff']),
  agentController.listAgentPlayersAdmin
);
router.get(
  '/admin/agents/:agentId/payouts',
  authMiddleware,
  requireAnyRole(['admin', 'super_admin', 'superuser', 'superadmin', 'manager', 'director', 'staff']),
  agentController.listAgentPayoutsAdmin
);

router.get(
  '/internal/agents',
  authMiddleware,
  requireAnyRole(['service', 'admin', 'super_admin', 'superuser', 'superadmin']),
  agentController.listAgentsByClub
);
router.post(
  '/internal/agents/status',
  authMiddleware,
  requireAnyRole(['service', 'admin', 'super_admin', 'superuser', 'superadmin']),
  agentController.updateAgentStatusInternal
);
router.get(
  '/internal/devices',
  authMiddleware,
  requireAnyRole(['service', 'admin', 'super_admin', 'superuser', 'superadmin']),
  agentController.listDevicesByClub
);

router.use('/admin/payments', authMiddleware, adminPaymentsRoutes);

module.exports = router;
