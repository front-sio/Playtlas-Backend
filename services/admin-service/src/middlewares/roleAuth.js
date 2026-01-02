const { authMiddleware } = require('../../../../shared/middlewares/authMiddleware');

function requireRoles(allowedRoles) {
  const allowed = new Set(allowedRoles || []);
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!allowed.has(role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  };
}

module.exports = {
  authMiddleware,
  requireRoles
};
