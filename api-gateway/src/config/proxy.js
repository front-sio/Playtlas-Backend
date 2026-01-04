// backend/api-gateway/config/proxy.js
const { createProxyMiddleware } = require('http-proxy-middleware');
const logger = require('../utils/logger');
let authMiddleware;
try {
  ({ authMiddleware } = require('/shared/middlewares/authMiddleware'));
} catch (error) {
  try {
    ({ authMiddleware } = require('../../shared/middlewares/authMiddleware'));
  } catch (innerError) {
    ({ authMiddleware } = require('../../../shared/middlewares/authMiddleware'));
  }
}

const setupProxy = (app) => {
  // Auth Service
  app.use('/api/auth', createProxyMiddleware({
    target: process.env.AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/auth': '' },
    onError: (err, req, res) => {
      logger.error('Auth Service Proxy Error:', err);
      res.status(502).json({ error: 'Auth service unavailable' });
    }
  }));

  // Wallet Service (Protected)
  app.use('/api/wallet', authMiddleware, createProxyMiddleware({
    target: process.env.WALLET_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/wallet': '' },
    onError: (err, req, res) => {
      logger.error('Wallet Service Proxy Error:', err);
      res.status(502).json({ error: 'Wallet service unavailable' });
    }
  }));

  // Payment Service (Protected)
  app.use('/api/payment', authMiddleware, createProxyMiddleware({
    target: process.env.PAYMENT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/payment': '' },
    onError: (err, req, res) => {
      logger.error('Payment Service Proxy Error:', err);
      res.status(502).json({ error: 'Payment service unavailable' });
    }
  }));

  const resolveTournamentTarget = () => {
    const target = process.env.TOURNAMENT_SERVICE_URL;
    if (!target) return 'http://localhost:3000';
    if (process.env.NODE_ENV !== 'production' && !process.env.DOCKERIZED && target.includes('tournament-service')) {
      return 'http://localhost:3000';
    }
    return target;
  };

  // Tournament Service (Protected)
  app.use('/api/tournament', authMiddleware, createProxyMiddleware({
    target: resolveTournamentTarget(),
    changeOrigin: true,
    pathRewrite: { '^/api/tournament': '/tournament' },
    onError: (err, req, res) => {
      logger.error('Tournament Service Proxy Error:', err);
      res.status(502).json({ error: 'Tournament service unavailable' });
    }
  }));

  // Player Service (Public endpoints)
  app.use('/api/player', createProxyMiddleware({
    target: process.env.PLAYER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/player': '/api/players' },
    onError: (err, req, res) => {
      logger.error('Player Service Proxy Error:', err);
      res.status(502).json({ error: 'Player service unavailable' });
    }
  }));

  // Admin Service (Protected)
  app.use('/api/admin', authMiddleware, createProxyMiddleware({
    target: process.env.ADMIN_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/admin': '' },
    onError: (err, req, res) => {
      logger.error('Admin Service Proxy Error:', err);
      res.status(502).json({ error: 'Admin service unavailable' });
    }
  }));

  // Agent Service (Protected)
  app.use('/api/agent', authMiddleware, createProxyMiddleware({
    target: process.env.AGENT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/agent': '' },
    onError: (err, req, res) => {
      logger.error('Agent Service Proxy Error:', err);
      res.status(502).json({ error: 'Agent service unavailable' });
    }
  }));

  // Matchmaking Service (Protected)
  app.use('/api/matchmaking', authMiddleware, createProxyMiddleware({
    target: process.env.MATCHMAKING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/matchmaking': '/matchmaking' },
    onError: (err, req, res) => {
      logger.error('Matchmaking Service Proxy Error:', err);
      res.status(502).json({ error: 'Matchmaking service unavailable' });
    }
  }));

  // Game Service (Protected)
  app.use('/api/game', authMiddleware, createProxyMiddleware({
    target: process.env.GAME_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/game': '' },
    onError: (err, req, res) => {
      logger.error('Game Service Proxy Error:', err);
      res.status(502).json({ error: 'Game service unavailable' });
    }
  }));

  // Notification Service (Protected)
  app.use('/api/notification', authMiddleware, createProxyMiddleware({
    target: process.env.NOTIFICATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/notification': '/notification' },
    onError: (err, req, res) => {
      logger.error('Notification Service Proxy Error:', err);
      res.status(502).json({ error: 'Notification service unavailable' });
    }
  }));

  // Revenue Analytics Service (Protected)
  app.use('/api/revenue', authMiddleware, createProxyMiddleware({
    target: process.env.REVENUE_ANALYTICS_SERVICE_URL || 'http://localhost:3008',
    changeOrigin: true,
    onError: (err, req, res) => {
      logger.error('Revenue Analytics Service Proxy Error:', err);
      res.status(502).json({ error: 'Revenue analytics service unavailable' });
    }
  }));

  logger.info('API Gateway proxy routes configured');
};

module.exports = { setupProxy };
