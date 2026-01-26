const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const { authenticate, authorize } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validate');

// Validation rules
const registerValidation = [
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('phoneNumber').isMobilePhone().withMessage('Valid phone number is required'),
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('gender').trim().isIn(['male', 'female']).withMessage('Gender must be either male or female'),
  body('channel').optional().isIn(['email', 'sms']).withMessage('Channel must be email or sms'),
  body('clubId').optional().isUUID().withMessage('clubId must be a valid UUID')
];

const loginValidation = [
  body('identifier').notEmpty().withMessage('Email, username, or phone is required'),
  body('password').notEmpty().withMessage('Password is required')
];

// Routes
router.post('/register', registerValidation, validate, authController.register);
router.post('/login', loginValidation, validate, authController.login);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerificationCode);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/refresh', authController.refreshToken);
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.getCurrentUser);
router.post('/change-password', authenticate, authController.changePassword);
const upload = require('../middlewares/uploadMiddleware');

// ... (existing code)

router.put('/avatar', authenticate, upload.single('avatar'), authController.updateAvatar);
router.put('/payout-phone', authenticate, authController.updatePayoutPhone);
router.post('/dev-auto-verify', authController.devAutoVerify);
router.get('/users/lookup/phone/:phoneNumber', authenticate, authController.lookupUserByPhone);

// Admin: user management and stats
const adminRoles = ['admin', 'super_admin', 'manager', 'director', 'staff'];
const serviceRoles = [...adminRoles, 'service', 'superuser', 'superadmin'];
router.post('/users', authenticate, authorize(adminRoles), authController.createUser);
router.get('/users', authenticate, authorize(adminRoles), authController.listUsers);
router.put('/users/:userId', authenticate, authorize(adminRoles), authController.updateUser);
router.post('/users/:userId/suspend', authenticate, authorize(adminRoles), authController.suspendUser);
router.get('/stats', authenticate, authorize(adminRoles), authController.getStats);
router.get('/internal/users/lookup', authenticate, authorize(serviceRoles), authController.lookupUsersByIds);

module.exports = router;
