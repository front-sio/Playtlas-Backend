const { prisma } = require('../config/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const logger = require('../utils/logger');
const { publishEvent, Topics } = require('../../../../shared');
const { enqueueOtpJob } = require('../utils/otpQueue');
const { createVerificationCode, verifyCode, resendVerificationCode } = require('../utils/verificationHelper');
const { authenticate, authorize } = require('../middlewares/authMiddleware'); 
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002';

const generateTokens = (userId, role) => {
  const accessToken = jwt.sign({ userId, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
  const refreshToken = jwt.sign({ userId, role }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN });
  return { accessToken, refreshToken };
};

const normalizePhoneNumber = (phoneNumber, countryCode = '+255') => {
  if (phoneNumber.startsWith('0')) {
    return `${countryCode}${phoneNumber.substring(1)}`;
  }
  if (!phoneNumber.startsWith('+')) {
    return `${countryCode}${phoneNumber}`;
  }
  return phoneNumber;
};

exports.createUser = async (req, res) => {
  try {
    const { username, email, password, phoneNumber, firstName, lastName, gender, role } = req.body;
    if (!username || !email || !password || !phoneNumber || !firstName || !lastName || !gender) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username },
          { phoneNumber: normalizedPhoneNumber }
        ]
      }
    });
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
        phoneNumber: normalizedPhoneNumber,
        firstName,
        lastName,
        gender,
        role: role || 'player',
        isVerified: true,
        verificationMethod: 'admin'
      }
    });

    if ((newUser.role || 'player') === 'player') {
      publishEvent(Topics.PLAYER_REGISTERED, {
        userId: newUser.userId,
        username,
        email,
        phoneNumber: normalizedPhoneNumber,
        firstName,
        lastName,
        gender
      }).catch((eventError) => {
        logger.error('Failed to publish PLAYER_REGISTERED event (non-blocking):', eventError);
      });
    }

    if ((newUser.role || '').toLowerCase() === 'agent') {
      publishEvent(Topics.AGENT_REGISTERED, {
        userId: newUser.userId,
        username,
        email,
        phoneNumber: normalizedPhoneNumber,
        firstName,
        lastName,
        gender
      }).catch((eventError) => {
        logger.error('Failed to publish AGENT_REGISTERED event (non-blocking):', eventError);
      });
    }

    delete newUser.password;
    res.status(201).json({
      success: true,
      data: { user: newUser }
    });
  } catch (error) {
    logger.error('Admin create user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create user',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

exports.register = async (req, res) => {
  try {
    const { username, email, password, phoneNumber, firstName, lastName, gender, channel } = req.body;
    const verificationChannel = channel === 'sms' ? 'sms' : 'email';

    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username },
          { phoneNumber: normalizedPhoneNumber }
        ]
      }
    });
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
        phoneNumber: normalizedPhoneNumber,
        firstName,
        lastName,
        gender,
        isVerified: false,
        verificationMethod: verificationChannel
      }
    });

    // Create verification code and send email
    try {
      const { code } = await createVerificationCode(newUser.userId, verificationChannel);
      const destination = verificationChannel === 'sms' ? normalizedPhoneNumber : email;
      await enqueueOtpJob({
        userId: newUser.userId,
        channel: verificationChannel,
        destination,
        code
      });
    } catch (verificationError) {
      logger.error('Failed to create verification code:', verificationError);
    }

    // Publish event for wallet and player profile creation
    // Non-blocking: registration succeeds even if Kafka is unavailable
    const role = (newUser.role || 'player').toLowerCase();
    if (role === 'agent') {
      publishEvent(Topics.AGENT_REGISTERED, {
        userId: newUser.userId,
        username,
        email,
        phoneNumber: normalizedPhoneNumber,
        firstName,
        lastName,
        gender
      }).catch((eventError) => {
        logger.error('Failed to publish AGENT_REGISTERED event (non-blocking):', eventError);
      });
    } else {
      publishEvent(Topics.PLAYER_REGISTERED, {
        userId: newUser.userId,
        username,
        email,
        phoneNumber: normalizedPhoneNumber,
        firstName,
        lastName,
        gender
      }).catch((eventError) => {
        logger.error('Failed to publish PLAYER_REGISTERED event (non-blocking):', eventError);
      });
    }

    const tokens = generateTokens(newUser.userId, newUser.role);
    await prisma.refreshToken.create({
      data: { userId: newUser.userId, token: tokens.refreshToken }
    });

    delete newUser.password;
    res.status(201).json({
      success: true,
      data: {
        user: { ...newUser, isVerified: false },
        ...tokens,
        requiresVerification: true,
        verificationChannel
      }
    });
  } catch (error) {
    logger.error('Registration error:', error);
    logger.error('Registration error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    res.status(500).json({
      success: false,
      error: 'Registration failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

exports.login = async (req, res) => {
  try {
    let { identifier, password } = req.body;
    
    // Enhanced logging for debugging
    logger.info('Login attempt started', {
      identifier: identifier,
      timestamp: new Date().toISOString(),
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    // Check if identifier could be a phone number and normalize it
    let normalizedIdentifier = identifier;
    if (/^\d+$/.test(identifier.replace(/^\+/, ''))) {
      normalizedIdentifier = normalizePhoneNumber(identifier);
      logger.info('Phone number normalized', {
        original: identifier,
        normalized: normalizedIdentifier
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: identifier },
          { phoneNumber: normalizedIdentifier }
        ]
      }
    });

    logger.info('User lookup result', {
      identifier: identifier,
      userFound: !!user,
      userId: user?.userId,
      isActive: user?.isActive,
      isVerified: user?.isVerified
    });

    if (!user || !user.isActive) {
      logger.warn('Login failed: User not found or inactive', {
        identifier,
        userFound: !!user,
        isActive: user?.isActive
      });
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    logger.info('Password validation result', {
      userId: user.userId,
      isValid: isPasswordValid
    });

    if (!isPasswordValid) {
      logger.warn('Login failed: Invalid password', {
        userId: user.userId,
        identifier
      });
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Check if user is verified
    if (!user.isVerified) {
      logger.warn('Login failed: User not verified', {
        userId: user.userId,
        email: user.email
      });
      
      // Resend verification code
      try {
        let preferredChannel = user.verificationMethod === 'sms' ? 'sms' : 'email';
        let destination = preferredChannel === 'sms' ? user.phoneNumber : user.email;
        if (!destination) {
          preferredChannel = 'email';
          destination = user.email;
        }
        const { code } = await resendVerificationCode(user.userId, preferredChannel);
        await enqueueOtpJob({
          userId: user.userId,
          channel: preferredChannel,
          destination,
          code
        });
        logger.info('Verification code resent', {
          userId: user.userId,
          channel: preferredChannel,
          destination
        });
      } catch (error) {
        logger.error('Failed to resend verification code:', error);
      }

      return res.status(403).json({
        success: false,
        error: 'Account not verified',
        requiresVerification: true,
        userId: user.userId,
        email: user.email,
        verificationChannel: user.verificationMethod || 'email',
        message: 'Please verify your account to continue. Check your verification code.'
      });
    }

    const tokens = generateTokens(user.userId, user.role);
    logger.info('Tokens generated successfully', {
      userId: user.userId,
      role: user.role
    });

    await prisma.refreshToken.create({
      data: { userId: user.userId, token: tokens.refreshToken }
    });
    
    await prisma.user.update({
      where: { userId: user.userId },
      data: { lastLogin: new Date() }
    });

    delete user.password;
    
    const response = { success: true, data: { user, ...tokens } };
    logger.info('Login successful', {
      userId: user.userId,
      username: user.username,
      email: user.email,
      timestamp: new Date().toISOString()
    });

    // Log the exact response being sent
    logger.info('Sending login response', {
      response: response,
      statusCode: 200
    });

    res.json(response);
  } catch (error) {
    logger.error('Login error:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({ success: false, error: 'Login failed' });
  }
};

// Use authenticate middleware for refreshToken
exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, error: 'Refresh token required' });

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const tokenExists = await prisma.refreshToken.findFirst({
      where: { token: refreshToken }
    });

    if (!tokenExists) return res.status(401).json({ success: false, error: 'Invalid refresh token' });

    const user = await prisma.user.findUnique({
      where: { userId: decoded.userId }
    });

    if (!user) return res.status(401).json({ success: false, error: 'User not found' });

    const tokens = generateTokens(user.userId, user.role);

    await prisma.refreshToken.deleteMany({
      where: { token: refreshToken }
    });
    await prisma.refreshToken.create({
      data: { userId: user.userId, token: tokens.refreshToken }
    });

    res.json({ success: true, data: tokens });
  } catch (error) {
    logger.error('Refresh token error:', error);
    res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
  }
};

// Use authenticate middleware for logout
exports.logout = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    // Ensure user is authenticated before logging out
    if (!req.user || !req.user.userId) {
       return res.status(401).json({ success: false, error: 'Authentication required for logout.' });
    }
    if (refreshToken) {
      await prisma.refreshToken.deleteMany({
        where: { token: refreshToken }
      });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ success: false, error: 'Logout failed' });
  }
};

// Use authenticate middleware for getCurrentUser
exports.getCurrentUser = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { userId: req.user.userId }
    });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    delete user.password;
    res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Get current user error:', error);
    res.status(500).json({ success: false, error: 'Failed to get user' });
  }
};

// Use authenticate and authorize middleware for updatePayoutPhone
exports.updatePayoutPhone = async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const userId = req.user.userId; // Authenticated user ID

    // Fetch user to check ownership and role
    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Check if the user is an admin or if they are updating their own profile
    // Role check: only admin or the user themselves can update payout phone.
    // Note: Player role check added to authorize middleware.
    const allowedRoles = ['admin', 'superuser', 'player']; // Assuming players can update their own phones
    if (!allowedRoles.includes(req.user.role) || (req.user.role === 'player' && user.userId !== req.user.userId)) {
       // If not admin and not the owner, deny access.
       // This check might need refinement based on exact role permissions for updating others.
       return res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions to update payout phone.' });
    }

    await prisma.user.update({
      where: { userId: userId },
      data: { payoutPhoneNumber: phoneNumber, updatedAt: new Date() }
    });
    const updatedUser = await prisma.user.findUnique({
      where: { userId: userId }
    });
    delete updatedUser.password;
    res.json({ success: true, data: updatedUser });
  } catch (error) {
    logger.error('Update payout phone error:', error);
    res.status(500).json({ success: false, error: 'Failed to update payout phone' });
  }
};

exports.verifyEmail = async (req, res) => {
  try {
    const { code, userId } = req.body;

    if (!code || !userId) {
      return res.status(400).json({ success: false, error: 'Code and userId are required' });
    }

    const result = await verifyCode(userId, code);
    if (!result.valid) {
      return res.status(400).json({ success: false, error: result.message });
    }

    const user = await prisma.user.findUnique({
      where: { userId }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    delete user.password;
    res.json({
      success: true,
      data: {
        user,
        message: 'Verification successful'
      }
    });
  } catch (error) {
    logger.error('Email verification error:', error);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
};

exports.resendVerificationCode = async (req, res) => {
  try {
    const { userId, channel } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const user = await prisma.user.findUnique({
      where: { userId }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const preferredChannel = channel ? (channel === 'sms' ? 'sms' : 'email') : (user.verificationMethod || 'email');
    const destination = preferredChannel === 'email' ? user.email : user.phoneNumber;
    if (!destination) {
      return res.status(400).json({ success: false, error: `No destination available for ${preferredChannel}` });
    }

    if (user.verificationMethod !== preferredChannel) {
      await prisma.user.update({
        where: { userId },
        data: { verificationMethod: preferredChannel }
      });
    }

    const { code } = await resendVerificationCode(userId, preferredChannel);

    await enqueueOtpJob({
      userId,
      channel: preferredChannel,
      destination,
      code
    });

    res.json({
      success: true,
      data: {
        message: `Verification code sent to ${destination}`,
        destination,
        verificationChannel: preferredChannel
      }
    });
  } catch (error) {
    logger.error('Resend verification code error:', error);
    res.status(500).json({ success: false, error: 'Failed to resend verification code' });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const { code } = await createVerificationCode(user.userId, 'password_reset');

    await enqueueOtpJob({
      userId: user.userId,
      channel: 'email',
      destination: email,
      code
    });

    res.json({
      success: true,
      data: {
        userId: user.userId,
        email,
        message: `Password reset code sent to ${email}`
      }
    });
  } catch (error) {
    logger.error('Forgot password error:', error);
    res.status(500).json({ success: false, error: 'Failed to send password reset code' });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { userId, code, newPassword } = req.body;

    if (!userId || !code || !newPassword) {
      return res.status(400).json({ success: false, error: 'userId, code, and newPassword are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const verification = await prisma.verificationCode.findFirst({
      where: {
        userId,
        code,
        type: 'password_reset',
        isUsed: false,
        expiresAt: { gt: new Date() }
      }
    });

    if (!verification) {
      return res.status(400).json({ success: false, error: 'Invalid or expired reset code' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.verificationCode.update({
      where: { id: verification.id },
      data: { isUsed: true }
    });

    await prisma.user.update({
      where: { userId },
      data: { password: hashedPassword, updatedAt: new Date() }
    });

    logger.info(`Password reset for user ${userId}`);

    res.json({
      success: true,
      data: {
        message: 'Password reset successfully'
      }
    });
  } catch (error) {
    logger.error('Reset password error:', error);
    res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
};

exports.listUsers = async (req, res) => {
  try {
    const { role, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (role) where.role = role;

    const take = parseInt(limit, 10);
    const skip = parseInt(offset, 10);

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          userId: true,
          username: true,
          email: true,
          phoneNumber: true,
          firstName: true,
          lastName: true,
          role: true,
          isActive: true,
          isVerified: true,
          lastLogin: true,
          createdAt: true
        }
      }),
      prisma.user.count({ where })
    ]);

    res.json({
      success: true,
      data: users,
      pagination: {
        limit: take,
        offset: skip,
        total
      }
    });
  } catch (error) {
    logger.error('List users error:', error);
    res.status(500).json({ success: false, error: 'Failed to list users' });
  }
};

exports.lookupUserByPhone = async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'phoneNumber is required' });
    }

    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    const user = await prisma.user.findUnique({
      where: { phoneNumber: normalizedPhoneNumber },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        phoneNumber: true
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    logger.error('Lookup user by phone error:', error);
    res.status(500).json({ success: false, error: 'Failed to lookup user' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const allowedFields = ['role', 'isActive', 'isVerified', 'firstName', 'lastName', 'email', 'phoneNumber', 'username'];
    const updateData = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const updated = await prisma.user.update({
      where: { userId },
      data: updateData,
      select: {
        userId: true,
        username: true,
        email: true,
        phoneNumber: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        isVerified: true,
        lastLogin: true,
        createdAt: true
      }
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Update user error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
};

exports.suspendUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const updated = await prisma.user.update({
      where: { userId },
      data: { isActive: false }
    });

    res.json({ success: true, data: { userId: updated.userId, isActive: updated.isActive } });
  } catch (error) {
    logger.error('Suspend user error:', error);
    res.status(500).json({ success: false, error: 'Failed to suspend user' });
  }
};

exports.getStats = async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totalUsers, activeUsers, verifiedUsers, newUsers] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { isVerified: true } }),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } })
    ]);

    res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        verifiedUsers,
        newUsersLast7Days: newUsers
      }
    });
  } catch (error) {
    logger.error('User stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user stats' });
  }
};

// Development-only endpoint to bypass email verification
exports.devAutoVerify = async (req, res) => {
  try {
    if (process.env.NODE_ENV !== 'development') {
      return res.status(403).json({ success: false, error: 'This endpoint is only available in development mode' });
    }

    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const user = await prisma.user.findUnique({
      where: { userId }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Mark user as verified
    await prisma.user.update({
      where: { userId },
      data: { isVerified: true }
    });

    // Invalidate all verification codes for this user
    await prisma.verificationCode.updateMany({
      where: { userId },
      data: { isUsed: true }
    });

    logger.info(`User ${userId} auto-verified in development mode`);

    res.json({
      success: true,
      data: {
        message: 'User auto-verified successfully',
        user: { ...user, isVerified: true }
      }
    });
  } catch (error) {
    logger.error('Dev auto-verify error:', error);
    res.status(500).json({ success: false, error: 'Failed to auto-verify user' });
  }
};
