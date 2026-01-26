const axios = require('axios');
const jwt = require('jsonwebtoken');
const logger = require('./logger');

const MATCHMAKING_SERVICE_URL = process.env.MATCHMAKING_SERVICE_URL || 'http://matchmaking-service:3009';
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
    logger.error({ err }, '[game-service] Failed to create service token');
    return null;
  }
}

async function syncMatchResult(matchId, payload) {
  if (!matchId) return false;
  const token = getServiceToken();
  if (!token) {
    logger.warn({ matchId }, '[game-service] Missing service token; skipping match result sync');
    return false;
  }
  try {
    await axios.put(
      `${MATCHMAKING_SERVICE_URL}/matchmaking/match/${encodeURIComponent(matchId)}/result`,
      payload,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      }
    );
    return true;
  } catch (error) {
    logger.warn({ err: error, matchId }, '[game-service] Failed to sync match result to matchmaking');
    return false;
  }
}

module.exports = {
  syncMatchResult
};
