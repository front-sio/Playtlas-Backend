const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole, requireAnyRole } = require('../middlewares/roleAuth');
const agentController = require('../controllers/agentController');

router.get('/me', authMiddleware, requireRole('agent'), agentController.getProfile);
router.post('/players/register', authMiddleware, requireRole('agent'), agentController.registerPlayer);
router.get('/players', authMiddleware, requireRole('agent'), agentController.listPlayers);
router.get('/transfer/lookup/phone/:phoneNumber', authMiddleware, requireRole('agent'), agentController.lookupRecipientByPhone);
router.post('/transfer', authMiddleware, requireRole('agent'), agentController.transferFloat);
router.get('/earnings', authMiddleware, requireRole('agent'), agentController.listEarnings);
router.post(
  '/admin/agents',
  authMiddleware,
  requireAnyRole(['admin', 'super_admin', 'superuser', 'superadmin', 'manager', 'director', 'staff']),
  agentController.createAgentProfile
);

module.exports = router;
