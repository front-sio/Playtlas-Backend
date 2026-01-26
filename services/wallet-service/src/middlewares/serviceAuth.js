const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const isValidServiceToken = (token) => {
  if (!token) return false;
  const staticToken = process.env.SERVICE_JWT_TOKEN || process.env.INTERNAL_SERVICE_TOKEN;
  if (staticToken && token === staticToken) return true;

  const secret = process.env.JWT_SECRET;
  if (!secret) return false;

  try {
    const decoded = jwt.verify(token, secret);
    return decoded?.role === 'service' || decoded?.userId === 'system';
  } catch (error) {
    logger.warn({ error: error.message }, '[wallet-service] Invalid service token');
    return false;
  }
};

const serviceAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const serviceToken = req.headers['x-service-token'];
  const token = serviceToken || bearerToken;

  if (!isValidServiceToken(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  return next();
};

module.exports = serviceAuth;
