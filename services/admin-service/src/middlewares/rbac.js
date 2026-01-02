const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const ActivityLogger = require('../utils/activityLogger');

const ROLE_PERMISSIONS = {
  super_admin: ['*'], // All permissions
  superuser: ['*'],
  superadmin: ['*'],
  admin: ['users:*', 'tournaments:*', 'wallets:*', 'reports:*', 'settings:*', 'logs:read', 'dashboard:read', 'games:*'],
  moderator: ['users:read', 'tournaments:read', 'reports:read', 'games:read', 'dashboard:read'],
  finance_manager: [
    'wallets:*',
    'transactions:*',
    'reports:financial',
    'dashboard:read',
    'tournaments:read'
  ],
  tournament_manager: ['tournaments:*', 'matches:*', 'players:read', 'games:read', 'dashboard:read'],
  game_manager: ['tournaments:*', 'games:*', 'dashboard:read'],
  game_master: ['tournaments:*', 'games:*', 'dashboard:read'],
  support: ['users:read', 'tournaments:read', 'tickets:*', 'dashboard:read'],
  staff: ['users:read', 'wallets:read', 'tournaments:read', 'games:read', 'dashboard:read'],
  manager: ['users:*', 'tournaments:*', 'wallets:*', 'reports:*', 'dashboard:read', 'games:*'],
  director: ['users:*', 'tournaments:*', 'wallets:*', 'reports:*', 'settings:*', 'logs:read', 'dashboard:read', 'games:*']
};

const normalizeRole = (role) => (typeof role === 'string' ? role.toLowerCase() : '');

const checkPermission = (userRole, requiredPermission) => {
  const normalizedRole = normalizeRole(userRole);
  const permissions = ROLE_PERMISSIONS[normalizedRole] || [];
  
  if (permissions.includes('*')) return true;
  
  const [resource, action] = requiredPermission.split(':');
  
  return permissions.some(perm => {
    if (perm === requiredPermission) return true;
    if (perm === `${resource}:*`) return true;
    return false;
  });
};

const authorize = (requiredPermission) => {
  return async (req, res, next) => {
    try {
      const userId = req.user?.userId;
      const tokenRole = req.user?.role;
      const normalizedTokenRole = normalizeRole(tokenRole);

      if (!userId) {
        return res.status(401).json({ 
          success: false, 
          error: 'Unauthorized - Admin authentication required' 
        });
      }

      let admin = await prisma.adminUser.findUnique({
        where: { userId }
      });

      if (!admin && normalizedTokenRole && ROLE_PERMISSIONS[normalizedTokenRole]) {
        try {
          admin = await prisma.adminUser.upsert({
            where: { userId },
            update: {
              role: normalizedTokenRole,
              lastLogin: new Date()
            },
            create: {
              userId,
              role: normalizedTokenRole,
              permissions: {},
              createdBy: userId
            }
          });
        } catch (error) {
          // If upsert fails due to race condition, fetch the existing record
          if (error.code === 'P2002') {
            admin = await prisma.adminUser.findUnique({
              where: { userId }
            });
          } else {
            throw error;
          }
        }
      }

      if (admin && normalizedTokenRole && ROLE_PERMISSIONS[normalizedTokenRole] && admin.role !== normalizedTokenRole) {
        admin = await prisma.adminUser.update({
          where: { userId },
          data: {
            role: normalizedTokenRole,
            lastLogin: new Date()
          }
        });
      }

      if (!admin) {
        return res.status(403).json({
          success: false,
          error: 'Admin user not found'
        });
      }

      if (!admin.isActive) {
        return res.status(403).json({ 
          success: false, 
          error: 'Admin account is inactive' 
        });
      }

      const adminRole = normalizeRole(admin.role);
      if (!checkPermission(adminRole, requiredPermission)) {
        await ActivityLogger.logError(
          admin.adminId,
          'access_denied',
          requiredPermission,
          'Insufficient permissions',
          { 
            userRole: adminRole || admin.role,
            requiredPermission,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
          }
        );

        return res.status(403).json({ 
          success: false, 
          error: 'Insufficient permissions',
          required: requiredPermission,
          userRole: adminRole || admin.role
        });
      }

      req.admin = admin;
      req.adminId = admin.adminId;
      req.userRole = admin.role;
      next();
    } catch (error) {
      logger.error('Authorization error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Authorization check failed' 
      });
    }
  };
};

module.exports = { authorize, checkPermission, ROLE_PERMISSIONS };
