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

const { setupProxy } = require('./config/proxy');
const { setupSocketIO } = require('./socket/socketHandler');
const logger = require('./utils/logger');
const errorHandler = require('./middlewares/errorHandler');

const NODE_ENV = process.env.NODE_ENV || 'development';
const app = express();
const server = http.createServer(app);

// Configure trust proxy when running behind a load balancer/reverse proxy
if (NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Shared CORS configuration
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Specific origins for production
const productionOrigins = [
  'https://play-atlas-games.vercel.app',
  'https://playatlasapi.sifex.co.tz',
  'https://play-atlas-frontend.vercel.app'
];

const resolveCorsOrigin = (origin, callback) => {
  if (!origin) {
    return callback(null, true);
  }

  // In production, use specific origins
  if (NODE_ENV === 'production') {
    if (productionOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  }

  // In development, allow all or use configured origins
  if (allowedOrigins.length === 0 || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
    return callback(null, true);
  }

  return callback(new Error('Not allowed by CORS'));
};

const defaultSocketPath = '/socket.io';
const socketPath = NODE_ENV === 'development'
  ? defaultSocketPath
  : (process.env.SOCKET_IO_PATH || defaultSocketPath);
logger.info(`Socket.IO path: ${socketPath}`, { service: 'api-gateway' });

// Socket.IO setup with improved CORS
const io = new Server(server, {
  path: socketPath,
  cors: {
    origin: NODE_ENV === 'production' ? productionOrigins : (process.env.SOCKET_IO_CORS_ORIGIN === '*' ? true : resolveCorsOrigin),
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true
  },
  allowEIO3: true,
  transports: ['websocket', 'polling']
});

// Middlewares
app.use(helmet());
app.use(
  cors({
    origin: NODE_ENV === 'production' ? productionOrigins : (allowedOrigins.length > 0 && !allowedOrigins.includes('*') ? allowedOrigins : true),
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
app.post('/internal/socket/broadcast', express.json(), (req, res) => {
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
    const { opponentIds = [], tournamentIds = [] } = req.body || {};
    const uniqueOpponents = Array.from(new Set(opponentIds.filter(Boolean)));
    const uniqueTournaments = Array.from(new Set(tournamentIds.filter(Boolean)));

    const playerServiceUrl = process.env.PLAYER_SERVICE_URL || 'http://localhost:3002';
    const tournamentServiceUrl = process.env.TOURNAMENT_SERVICE_URL || 'http://localhost:3004';

    const opponents = {};
    const tournaments = {};

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
      )
    ]);

    res.json({ success: true, data: { opponents, tournaments } });
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
