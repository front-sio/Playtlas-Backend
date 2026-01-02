// 
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

const resolveCorsOrigin = (origin, callback) => {
  if (!origin) {
    return callback(null, true);
  }

  if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
    return callback(null, true);
  }

  return callback(new Error('Not allowed by CORS'));
};

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.SOCKET_CORS_ORIGIN || resolveCorsOrigin,
    methods: ['GET', 'POST']
  }
});

// Middlewares
app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true
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

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api', limiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'api-gateway', env: NODE_ENV, timestamp: new Date().toISOString() });
});

// Setup Socket.IO
setupSocketIO(io);

// Setup API Gateway Proxy (Must be before body parsers)
setupProxy(app);

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
