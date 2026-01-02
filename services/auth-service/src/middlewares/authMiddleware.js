const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

// Middleware for authentication: Verifies JWT and attaches decoded user to req.user
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      next();
    } catch (err) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }
  } catch (error) {
    logger.error('Authentication middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

// Middleware for authorization: Checks user's role against allowed roles
const authorize = (allowedRoles) => {
  return (req, res, next) => {
    // Ensure user is authenticated and has a role property
    if (!req.user || !req.user.role) {
      return res.status(401).json({ success: false, error: 'Authentication required. User role not found.' });
    }

    const userRole = req.user.role;

    // Check if user's role is within the allowed roles
    if (allowedRoles.includes(userRole)) {
      next(); // User has the required role, proceed
    } else {
      // User does not have the required role
      return res.status(403).json({ success: false, error: 'Forbidden: Insufficient role permissions.' });
    }
  };
};

// Export both authenticate (aliased from authMiddleware) and authorize
module.exports = {
  authenticate, // Exporting authMiddleware as authenticate
  authorize
};
