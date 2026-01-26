const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { env } = require('../../../../shared/config/env');

const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    if (!env.JWT_SECRET) {
      logger.error('[revenue-analytics] JWT_SECRET is not configured');
      return res.status(500).json({ success: false, error: 'Auth configuration error' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, env.JWT_SECRET);

    req.user = {
      userId: decoded.userId || decoded.sub,
      role: decoded.role,
      email: decoded.email
    };

    return next();
  } catch (error) {
    logger.warn('[revenue-analytics] Auth failed', { error: error.message });
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

module.exports = authenticate;
