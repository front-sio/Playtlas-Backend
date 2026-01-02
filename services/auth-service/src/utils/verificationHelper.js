const { prisma } = require('../config/db');
const logger = require('./logger');

const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const createVerificationCode = async (userId, type = 'email') => {
  try {
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const verificationCode = await prisma.verificationCode.create({
      data: {
        userId,
        code,
        type,
        expiresAt
      }
    });

    logger.info(`Verification code created for user ${userId} via ${type}`);
    return { code, expiresAt };
  } catch (error) {
    logger.error('Error creating verification code:', error);
    throw error;
  }
};

const verifyCode = async (userId, code) => {
  try {
    const verification = await prisma.verificationCode.findFirst({
      where: {
        userId,
        code,
        isUsed: false,
        expiresAt: { gt: new Date() }
      }
    });

    if (!verification) {
      return { valid: false, message: 'Invalid or expired code' };
    }

    // Mark as used
    await prisma.verificationCode.update({
      where: { id: verification.id },
      data: { isUsed: true }
    });

    // Mark user as verified
    await prisma.user.update({
      where: { userId },
      data: { isVerified: true }
    });

    logger.info(`User ${userId} verified successfully`);
    return { valid: true, message: 'Email verified successfully' };
  } catch (error) {
    logger.error('Error verifying code:', error);
    throw error;
  }
};

const resendVerificationCode = async (userId, type = 'email') => {
  try {
    // Invalidate old codes
    await prisma.verificationCode.updateMany({
      where: { userId, isUsed: false },
      data: { isUsed: true }
    });

    // Create new code
    return await createVerificationCode(userId, type);
  } catch (error) {
    logger.error('Error resending verification code:', error);
    throw error;
  }
};

module.exports = {
  generateVerificationCode,
  createVerificationCode,
  verifyCode,
  resendVerificationCode
};
