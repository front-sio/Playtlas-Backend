const logger = require('../utils/logger');

/**
 * Authentication middleware for revenue analytics service
 * Validates JWT token and extracts user information
 */
const authenticate = (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Decode token (basic implementation - in production, use JWT verification)
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return res.status(401).json({ success: false, error: 'Invalid token format' });
      }
      
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      
      // Attach user info to request
      req.user = {
        userId: decoded.userId || decoded.sub,
        role: decoded.role,
        email: decoded.email
      };

      next();
    } catch (decodeError) {
      logger.warn('Failed to decode token:', decodeError.message);
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(401).json({ success: false, error: 'Authentication failed' });
  }
};

module.exports = authenticate;
