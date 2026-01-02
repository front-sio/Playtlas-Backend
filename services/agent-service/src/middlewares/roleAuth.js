const { authMiddleware } = require('../../../../shared/middlewares/authMiddleware');

function requireRole(role) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (userRole !== role) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  };
}

function requireAnyRole(roles) {
  const allowed = new Set((roles || []).map((r) => String(r).toLowerCase()));
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!allowed.has(String(userRole).toLowerCase())) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  };
}

module.exports = {
  authMiddleware,
  requireRole,
  requireAnyRole
};
