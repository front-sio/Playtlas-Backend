const express = require('express');
const router = express.Router();

const controller = require('../controllers/tournamentApprovalsController');
const { authMiddleware, requireRoles } = require('../middlewares/roleAuth');

// Request roles (create/start/stop/cancel)
router.post(
  '/tournaments/create',
  authMiddleware,
  requireRoles(['super_admin', 'admin', 'game_master']),
  controller.requestCreateTournament
);

router.post(
  '/tournaments/:tournamentId/action',
  authMiddleware,
  requireRoles(['super_admin', 'admin', 'game_master']),
  controller.requestTournamentAction
);

// Approver roles (approve/reject)
router.get(
  '/',
  authMiddleware,
  requireRoles(['super_admin', 'manager', 'director']),
  controller.listApprovals
);

router.post(
  '/:approvalId/approve',
  authMiddleware,
  requireRoles(['super_admin', 'manager', 'director']),
  controller.approve
);

router.post(
  '/:approvalId/reject',
  authMiddleware,
  requireRoles(['super_admin', 'manager', 'director']),
  controller.reject
);

module.exports = router;

