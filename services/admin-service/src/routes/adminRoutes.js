const express = require('express');
const router = express.Router();
const { body, query, param } = require('express-validator');
const adminController = require('../controllers/adminController');
const { authorize } = require('../middlewares/rbac');
const { handleValidationErrors } = require('../middlewares/errorHandler');

// Admin User Management
router.post('/admins',
  authorize('users:create'),
  [
    body('userId').isUUID().withMessage('Valid userId is required'),
    body('role').isIn([
      'admin',
      'moderator',
      'finance_manager',
      'tournament_manager',
      'game_manager',
      'game_master',
      'support',
      'super_admin',
      'superuser',
      'superadmin'
    ])
      .withMessage('Valid role is required'),
    handleValidationErrors
  ],
  adminController.createAdmin
);

router.get('/admins',
  authorize('users:read'),
  [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
    handleValidationErrors
  ],
  adminController.getAdmins
);

router.put('/admins/:adminId',
  authorize('users:update'),
  [
    param('adminId').isUUID(),
    handleValidationErrors
  ],
  adminController.updateAdmin
);

router.delete('/admins/:adminId',
  authorize('users:delete'),
  [
    param('adminId').isUUID(),
    handleValidationErrors
  ],
  adminController.deleteAdmin
);

// System Settings
router.get('/settings',
  authorize('settings:read'),
  adminController.getSettings
);

router.put('/settings',
  authorize('settings:update'),
  [
    body('key').notEmpty().withMessage('Setting key is required'),
    body('value').notEmpty().withMessage('Setting value is required'),
    body('category').notEmpty().withMessage('Category is required'),
    handleValidationErrors
  ],
  adminController.updateSetting
);

// Activity Logs
router.get('/logs',
  authorize('logs:read'),
  [
    query('limit').optional().isInt({ min: 1, max: 1000 }),
    query('offset').optional().isInt({ min: 0 }),
    handleValidationErrors
  ],
  adminController.getActivityLogs
);

// User Management
router.get('/users',
  authorize('users:read'),
  adminController.getAllUsers
);

router.get('/agents',
  authorize('users:read'),
  adminController.getAgents
);

router.post('/agents',
  authorize('users:create'),
  [
    body('username').notEmpty().withMessage('Username is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('phoneNumber').notEmpty().withMessage('Phone number is required'),
    body('firstName').notEmpty().withMessage('First name is required'),
    body('lastName').notEmpty().withMessage('Last name is required'),
    body('gender').isIn(['male', 'female']).withMessage('Gender must be either male or female'),
    handleValidationErrors
  ],
  adminController.createAgent
);

router.put('/users/:userId',
  authorize('users:update'),
  [
    param('userId').isUUID(),
    handleValidationErrors
  ],
  adminController.updateUser
);

router.post('/users/:userId/suspend',
  authorize('users:update'),
  [
    param('userId').isUUID(),
    body('reason').notEmpty().withMessage('Suspension reason is required'),
    handleValidationErrors
  ],
  adminController.suspendUser
);

// Reports
router.post('/reports/financial',
  authorize('reports:financial'),
  [
    body('startDate').isISO8601().withMessage('Valid start date is required'),
    body('endDate').isISO8601().withMessage('Valid end date is required'),
    handleValidationErrors
  ],
  adminController.generateFinancialReport
);

// Tournament Management
router.get('/tournaments/stats',
  authorize('tournaments:read'),
  adminController.getTournamentStats
);

router.post('/tournaments/:tournamentId/cancel',
  authorize('tournaments:update'),
  [
    param('tournamentId').isUUID(),
    body('reason').notEmpty().withMessage('Cancellation reason is required'),
    handleValidationErrors
  ],
  adminController.cancelTournament
);

// Dashboard
router.get('/dashboard',
  authorize('dashboard:read'),
  adminController.getDashboardStats
);

// Game Management
router.get('/games/sessions',
  authorize('games:read'),
  [
    query('status').optional(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    handleValidationErrors
  ],
  adminController.getGameSessions
);

router.post('/games/sessions/:sessionId/cancel',
  authorize('games:update'),
  [
    param('sessionId').isUUID(),
    handleValidationErrors
  ],
  adminController.cancelGameSession
);

router.delete('/games/sessions/:sessionId',
  authorize('games:delete'),
  [
    param('sessionId').isUUID(),
    handleValidationErrors
  ],
  adminController.deleteGameSession
);

// Wallet/Transaction Management
router.get('/wallets',
  authorize('wallets:read'),
  [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
    handleValidationErrors
  ],
  adminController.getWallets
);

router.get('/wallets/:walletId',
  authorize('wallets:read'),
  [
    param('walletId').isUUID(),
    handleValidationErrors
  ],
  adminController.getWalletDetails
);

router.get('/transactions',
  authorize('transactions:read'),
  [
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
    query('status').optional(),
    query('type').optional(),
    handleValidationErrors
  ],
  adminController.getTransactions
);

router.get('/transactions/pending',
  authorize('transactions:read'),
  [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    handleValidationErrors
  ],
  adminController.getPendingTransactions
);

router.post('/transactions/:transactionId/approve',
  authorize('transactions:approve'),
  [
    param('transactionId').isUUID(),
    body('notes').optional(),
    handleValidationErrors
  ],
  adminController.approveTransaction
);

router.post('/transactions/:transactionId/reject',
  authorize('transactions:approve'),
  [
    param('transactionId').isUUID(),
    body('reason').notEmpty().withMessage('Rejection reason is required'),
    handleValidationErrors
  ],
  adminController.rejectTransaction
);

router.post('/wallets/:walletId/credit',
  authorize('wallets:credit'),
  [
    param('walletId').isUUID(),
    body('amount').isFloat({ min: 0.01 }),
    body('description').notEmpty(),
    handleValidationErrors
  ],
  adminController.creditWallet
);

router.post('/wallets/:walletId/debit',
  authorize('wallets:debit'),
  [
    param('walletId').isUUID(),
    body('amount').isFloat({ min: 0.01 }),
    body('description').notEmpty(),
    handleValidationErrors
  ],
  adminController.debitWallet
);

// Tournament Creation & Management
router.post('/tournaments',
  authorize('tournaments:create'),
  [
    body('name').notEmpty().withMessage('Tournament name is required'),
    body('description').optional(),
    body('entryFee').isFloat({ min: 0 }),
    body('maxPlayers').optional().isInt({ min: 2 }),
    body('startTime').optional().isISO8601(),
    body('matchDuration').optional().isInt({ min: 60 }),
    body('seasonDuration').optional().isInt({ min: 300 }),
    handleValidationErrors
  ],
  adminController.createTournament
);

router.get('/tournaments',
  authorize('tournaments:read'),
  [
    query('status').optional(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    handleValidationErrors
  ],
  adminController.getTournaments
);

router.put('/tournaments/:tournamentId',
  authorize('tournaments:update'),
  [
    param('tournamentId').isUUID(),
    handleValidationErrors
  ],
  adminController.updateTournament
);

router.delete('/tournaments/:tournamentId',
  authorize('tournaments:delete'),
  [
    param('tournamentId').isUUID(),
    handleValidationErrors
  ],
  adminController.deleteTournament
);

router.post('/tournaments/:tournamentId/start',
  authorize('tournaments:update'),
  [
    param('tournamentId').isUUID(),
    handleValidationErrors
  ],
  adminController.startTournament
);

module.exports = router;
