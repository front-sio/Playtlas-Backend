const jwt = require('jsonwebtoken');
const logger = require('./logger');

const SERVICE_JWT_TOKEN = process.env.SERVICE_JWT_TOKEN || process.env.PAYMENT_SERVICE_TOKEN || null;

let cachedServiceToken = null;
let cachedServiceTokenExpiry = 0;

function getServiceToken() {
  if (SERVICE_JWT_TOKEN) return SERVICE_JWT_TOKEN;
  const now = Date.now();
  if (cachedServiceToken && now < cachedServiceTokenExpiry) {
    return cachedServiceToken;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const token = jwt.sign({ userId: 'system', role: 'service' }, secret, { expiresIn: '5m' });
    cachedServiceToken = token;
    cachedServiceTokenExpiry = now + 4 * 60 * 1000;
    return token;
  } catch (err) {
    logger.error({ err }, 'Failed to create service token');
    return null;
  }
}

module.exports = {
  getServiceToken
};
