require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

const gameRoutes = require('./routes/gameRoutes');
const logger = require('./utils/logger');
const { startGameSessionCleanupWorker } = require('./jobs/gameSessionCleanupWorker');
const { setupGameSocketHandlers, startTimeoutChecker } = require('./controllers/gameSocketController');
const { initializeAuthoritativeSocket } = require('./controllers/authoritativeSocketController');

const NODE_ENV = process.env.NODE_ENV || 'development';
const app = express();

if (NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
    credentials: true
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/', gameRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'game-service', env: NODE_ENV, timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Internal Server Error' });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection at Promise:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception thrown:', err);
  if (NODE_ENV === 'production') {
    process.exit(1);
  }
});

const PORT = process.env.PORT || 3006;
const httpServer = createServer(app);

// Setup Socket.IO for real-time gameplay
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Setup game socket handlers
setupGameSocketHandlers(io);

// Setup authoritative physics socket handlers
initializeAuthoritativeSocket(io);

// Start periodic timeout checker for expired matches
startTimeoutChecker(io);

// Make io accessible to routes
app.set('io', io);

httpServer.listen(PORT, () => {
  logger.info(`Game Service running on port ${PORT}`);
  logger.info(`Socket.IO server ready for connections`);
  logger.info(`Environment: ${NODE_ENV}`);
});

// Start background workers
if (process.env.DISABLE_GAME_SESSION_CLEANUP === 'true') {
  logger.warn('Game session cleanup worker disabled via DISABLE_GAME_SESSION_CLEANUP');
} else {
  try {
    startGameSessionCleanupWorker();
  } catch (error) {
    if (error.message.includes('bullmq') || error.message.includes('Redis')) {
      logger.warn('Redis/BullMQ not available, running without background workers');
    } else {
      logger.error({ err: error }, 'Failed to start game session cleanup worker');
    }
  }
}

module.exports = { app, io };
