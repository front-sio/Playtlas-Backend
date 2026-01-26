// backend/api-gateway/src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const { setupProxy } = require('./config/proxy');
const { setupSocketIO } = require('./socket/socketHandler');
const logger = require('./utils/logger');
const errorHandler = require('./middlewares/errorHandler');

const NODE_ENV = process.env.NODE_ENV || 'development';
const app = express();
const server = http.createServer(app);
const SERVICE_JWT_TOKEN = process.env.SERVICE_JWT_TOKEN || process.env.PAYMENT_SERVICE_TOKEN || null;
let cachedServiceToken = null;
let cachedServiceTokenExpiry = 0;

const getServiceToken = () => {
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
  } catch (error) {
    logger.error({ error }, '[api-gateway] Failed to create service token');
    return null;
  }
};

const isValidServiceToken = (token) => {
  if (!token) return false;
  if (SERVICE_JWT_TOKEN && token === SERVICE_JWT_TOKEN) return true;
  const secret = process.env.JWT_SECRET;
  if (!secret) return false;
  try {
    const decoded = jwt.verify(token, secret);
    return decoded?.role === 'service' || decoded?.userId === 'system';
  } catch {
    return false;
  }
};

const requireInternalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const serviceToken = req.headers['x-service-token'];
  const token = serviceToken || bearerToken;

  if (!isValidServiceToken(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  return next();
};

// Configure trust proxy when running behind a load balancer/reverse proxy
if (NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Shared CORS configuration
const parseOrigins = (value) => (value || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins = parseOrigins(process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || '');
const socketAllowedOrigins = parseOrigins(process.env.SOCKET_IO_CORS_ORIGIN || '');

const DEFAULT_DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const productionOrigins = [
  'https://play-atlas-games.vercel.app',
  'https://playatlasapi.sifex.co.tz',
  'https://play-atlas-frontend.vercel.app',
  'https://game.stebofarm.co.tz',
  'https://api.stebofarm.co.tz'
];

const getDefaultOrigins = () =>
  NODE_ENV === 'production' ? productionOrigins : DEFAULT_DEV_ORIGINS;

const isOriginAllowed = (origin, origins) => {
  if (!origin) return true;
  return origins.includes('*') || origins.includes(origin);
};

const resolveCorsOrigin = (origin, callback) => {
  const targetOrigins = allowedOrigins.length > 0 ? allowedOrigins : getDefaultOrigins();
  if (isOriginAllowed(origin, targetOrigins)) {
    return callback(null, true);
  }
  return callback(new Error('Not allowed by CORS'));
};

const resolveSocketCorsOrigin = (origin, callback) => {
  let targetOrigins = [];
  if (socketAllowedOrigins.length > 0) {
    targetOrigins = socketAllowedOrigins;
  } else if (allowedOrigins.length > 0) {
    targetOrigins = allowedOrigins;
  } else {
    targetOrigins = getDefaultOrigins();
  }

  if (isOriginAllowed(origin, targetOrigins)) {
    return callback(null, true);
  }
  return callback(new Error('Not allowed by CORS'));
};

const effectiveCorsOrigins = allowedOrigins.length > 0 ? allowedOrigins : getDefaultOrigins();
const effectiveSocketCorsOrigins =
  socketAllowedOrigins.length > 0
    ? socketAllowedOrigins
    : allowedOrigins.length > 0
      ? allowedOrigins
      : getDefaultOrigins();

// Log CORS configuration for debugging
logger.info(`CORS Origins: ${effectiveCorsOrigins.join(', ')}`, { service: 'api-gateway' });
logger.info(`Socket.IO CORS Origins: ${effectiveSocketCorsOrigins.join(', ')}`, { service: 'api-gateway' });

const defaultSocketPath = '/socket.io';
const socketPath = NODE_ENV === 'development'
  ? defaultSocketPath
  : (process.env.SOCKET_IO_PATH || defaultSocketPath);
logger.info(`Socket.IO path: ${socketPath}`, { service: 'api-gateway' });

// Socket.IO setup with improved CORS
const io = new Server(server, {
  path: socketPath,
  cors: {
    origin: resolveSocketCorsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true
  },
  allowEIO3: true,
  transports: ['websocket', 'polling']
});

// Explicit CORS middleware for Socket.IO endpoints
app.use('/socket.io/*', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin, effectiveSocketCorsOrigins)) {
    return res.status(403).end();
  }
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  next();
});

// Middlewares
app.use(helmet());
app.use(
  cors({
    origin: resolveCorsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept']
  })
);
app.use(compression());
app.use(
  morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) }
  })
);
// Body parsers moved after proxy to avoid stream consumption issues
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));

// Rate limiting (disabled for development)
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.'
});

// Only apply rate limiting in production
if (NODE_ENV === 'production' && process.env.RATE_LIMIT_ENABLED !== 'false') {
  app.use('/api', limiter);
  logger.info('Rate limiting enabled for production');
} else {
  logger.info('Rate limiting disabled for development');
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'api-gateway', env: NODE_ENV, timestamp: new Date().toISOString() });
});

// Internal socket broadcast endpoint for services
app.post('/internal/socket/broadcast', requireInternalAuth, express.json(), (req, res) => {
  try {
    const { type, data } = req.body;

    if (!type || !data) {
      return res.status(400).json({ success: false, error: 'Type and data are required' });
    }

    switch (type) {
      case 'user:notification':
        if (data.userId && data.notification) {
          io.to(`user:${data.userId}`).emit('notification:new', data.notification);
          logger.info({ userId: data.userId, type: data.notification.type }, '[internal/socket] User notification sent');
        }
        break;

      case 'global:notification':
        if (data.notification) {
          io.emit('notification:broadcast', data.notification);
          logger.info({ type: data.notification.type }, '[internal/socket] Global notification broadcasted');
        }
        break;

      case 'tournament:season_created':
        if (data.tournamentId && data.seasonData) {
          io.to(`tournament:${data.tournamentId}`).emit('tournament:season_created', data.seasonData);
          logger.info({ tournamentId: data.tournamentId }, '[internal/socket] Season created notification sent');
        }
        break;

      case 'match:ready':
        if (data.matchData) {
          const { player1Id, player2Id, matchId } = data.matchData;
          io.to(`user:${player1Id}`).emit('match:ready', data.matchData);
          io.to(`user:${player2Id}`).emit('match:ready', data.matchData);
          logger.info({ matchId, player1Id, player2Id }, '[internal/socket] Match ready notifications sent');
        }
        break;

      default:
        return res.status(400).json({ success: false, error: 'Unknown broadcast type' });
    }

    res.json({ success: true, message: 'Broadcast sent' });
  } catch (error) {
    logger.error({ error }, '[internal/socket] Broadcast failed');
    res.status(500).json({ success: false, error: 'Broadcast failed' });
  }
});

// Batch lookup for match metadata
app.post('/api/lookup/matches', express.json(), async (req, res) => {
  try {
    const { opponentIds = [], tournamentIds = [], agentUserIds = [] } = req.body || {};
    const uniqueOpponents = Array.from(new Set(opponentIds.filter(Boolean)));
    const uniqueTournaments = Array.from(new Set(tournamentIds.filter(Boolean)));
    const uniqueAgentUsers = Array.from(new Set(agentUserIds.filter(Boolean)));

    const playerServiceUrl = process.env.PLAYER_SERVICE_URL || 'http://localhost:3002';
    const tournamentServiceUrl = process.env.TOURNAMENT_SERVICE_URL || 'http://localhost:3004';
    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

    const opponents = {};
    const tournaments = {};
    const agents = {};
    const opponentAvatars = {};

    await Promise.all([
      Promise.all(
        uniqueOpponents.map(async (opponentId) => {
          try {
            const response = await fetch(`${playerServiceUrl}/api/players/${opponentId}/stats`);
            if (!response.ok) return;
            const payload = await response.json();
            const username = payload?.data?.username;
            if (username) opponents[opponentId] = username;
          } catch (error) {
            logger.error({ error, opponentId }, '[lookup/matches] Failed to resolve opponent');
          }
        })
      ),
      Promise.all(
        uniqueTournaments.map(async (tournamentId) => {
          try {
            const response = await fetch(`${tournamentServiceUrl}/tournament/${tournamentId}`);
            if (!response.ok) return;
            const payload = await response.json();
            const name = payload?.data?.name;
            if (name) tournaments[tournamentId] = name;
          } catch (error) {
            logger.error({ error, tournamentId }, '[lookup/matches] Failed to resolve tournament');
          }
        })
      ),
      (async () => {
        if (!uniqueAgentUsers.length) return;
        const serviceToken = getServiceToken();
        if (!serviceToken) {
          logger.warn('[lookup/matches] Missing service token; cannot resolve agent names');
          return;
        }
        try {
          const response = await fetch(
            `${authServiceUrl}/internal/users/lookup?ids=${encodeURIComponent(uniqueAgentUsers.join(','))}`,
            { headers: { Authorization: `Bearer ${serviceToken}` } }
          );
          if (!response.ok) return;
          const payload = await response.json();
          const users = payload?.data || [];
          users.forEach((user) => {
            if (user?.userId && user?.displayName) {
              agents[user.userId] = user.displayName;
            }
          });
        } catch (error) {
          logger.error({ error }, '[lookup/matches] Failed to resolve agent names');
        }
      })()
      ,
      (async () => {
        if (!uniqueOpponents.length) return;
        const serviceToken = getServiceToken();
        if (!serviceToken) {
          logger.warn('[lookup/matches] Missing service token; cannot resolve opponent avatars');
          return;
        }
        try {
          const response = await fetch(
            `${authServiceUrl}/internal/users/lookup?ids=${encodeURIComponent(uniqueOpponents.join(','))}`,
            { headers: { Authorization: `Bearer ${serviceToken}` } }
          );
          if (!response.ok) return;
          const payload = await response.json();
          const users = payload?.data || [];
          users.forEach((user) => {
            if (user?.userId && user?.displayName) {
              opponents[user.userId] = opponents[user.userId] || user.displayName;
            }
            if (user?.userId && user?.avatarUrl) {
              opponentAvatars[user.userId] = user.avatarUrl;
            }
          });
        } catch (error) {
          logger.error({ error }, '[lookup/matches] Failed to resolve opponent avatars');
        }
      })()
    ]);

    res.json({ success: true, data: { opponents, opponentAvatars, tournaments, agents } });
  } catch (error) {
    logger.error({ error }, '[lookup/matches] Failed to resolve match lookups');
    res.status(500).json({ success: false, error: 'Failed to resolve match lookups' });
  }
});

// Setup Socket.IO
setupSocketIO(io);

// Setup API Gateway Proxy (Must be before body parsers)
setupProxy(app, server);

// Body parsers (only for non-proxied routes)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Error handling
app.use(errorHandler);

// Global process-level error handlers
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection at Promise:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception thrown:', err);
  if (NODE_ENV === 'production') {
    // Let the process crash in production and rely on the orchestrator to restart it
    process.exit(1);
  }
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
  logger.info(`Environment: ${NODE_ENV}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
  });
});

module.exports = { app, io };
