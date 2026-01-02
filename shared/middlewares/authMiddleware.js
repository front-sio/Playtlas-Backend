// JWT authentication middleware for Express.

const jwt = require('jsonwebtoken');
const { env } = require('../config/env');

/**
 * Verify Bearer JWT token and attach decoded payload to req.user.
 *
 * Usage:
 *   const { authMiddleware } = require('../../shared/middlewares/authMiddleware');
 *   app.use('/wallet', authMiddleware, walletRouter);
 */
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }

  if (!env.JWT_SECRET) {
    console.error('[authMiddleware] JWT_SECRET not configured');
    return res.status(500).json({ message: 'Auth configuration error' });
  }

  const token = header.substring('Bearer '.length);

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

module.exports = {
  authMiddleware
};