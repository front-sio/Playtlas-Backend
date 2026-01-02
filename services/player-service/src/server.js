const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const winston = require('winston');
// const rateLimit = require('express-rate-limit'); // Commented out due to module issues

const playerRoutes = require('./routes/playerRoutes'); // Assuming routes are defined here
// const authRoutes = require('./routes/authRoutes'); // Commented out - doesn't exist
// const matchmakingRoutes = require('./routes/matchmakingRoutes'); // Assuming matchmaking routes
// const gameRoutes = require('./routes/gameRoutes'); // Assuming game routes
// const tournamentRoutes = require('./routes/tournamentRoutes'); // Assuming tournament routes
// const notificationRoutes = require('./routes/notificationRoutes'); // Assuming notification routes
// const walletRoutes = require('./routes/walletRoutes'); // Assuming wallet routes are handled here or elsewhere

// Import and start the commission job scheduler
// const { startCommissionJob } = require('./jobs/CommissionJob'); // Commented out - TypeScript file
const { startPlayerConsumers } = require('./kafka/consumers');

dotenv.config();

const PORT = process.env.PORT || 3002;
const NODE_ENV = process.env.NODE_ENV || 'development';

const logger = winston.createLogger({
  level: NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    // Add file transport for production if needed
  ],
});

const app = express();

// Middlewares
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: '1mb' })); // Limit request body size
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting - commented out due to module issues
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   message: 'Too many requests from this IP, please try again after 15 minutes'
// });
// app.use('/api', limiter); // Apply to all API routes

// Basic route
app.get('/', (req, res) => {
  res.send('Player Service API is running!');
});

// API Routes - prefixing with /api
app.use('/api/players', playerRoutes);
// app.use('/api/auth', authRoutes); // Auth might be a separate service, or shared. Adjust if needed.
// app.use('/api/matchmaking', matchmakingRoutes); // Adjust routes based on service responsibilities
// app.use('/api/game', gameRoutes);
// app.use('/api/tournaments', tournamentRoutes);
// app.use('/api/notifications', notificationRoutes);
// app.use('/api/wallet', walletRoutes); // Wallet functionality might be here or in a dedicated service.

// Example: Handling route for wallet payouts in wallet-service, adjust if wallet routes are elsewhere
// This assumes wallet routes are handled within this service or correctly proxied.
// If wallet service is separate, this would be handled by API Gateway or other routing.
// For now, assuming basic wallet routes might be here or need to be proxied.

// Placeholder for routes that might be handled by this service, adjust based on actual setup
// app.use('/api/wallet/payouts', payoutRoutes); // Example if payout routes are directly here


// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`${err.message}`, { stack: err.stack });
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || 'Something went wrong!',
  });
});

// Start the commission job scheduler
// Ensure this is called *after* services are initialized and ready, if necessary.
// For simplicity, calling it directly here.
// startCommissionJob();
// logger.info('Commission job scheduler started.');

// Start Kafka consumers (non-blocking)
startPlayerConsumers().catch(err => {
  logger.error('Failed to start player consumers:', err);
});

const server = app.listen(PORT, () => {
  logger.info(`Player Service running on port ${PORT} in ${NODE_ENV} mode`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('unhandledRejection', (err, promise) => {
  logger.error(`Unhandled Rejection: ${err.message}`, { stack: err.stack });
  // Consider shutting down the server gracefully
  server.close(() => {
    logger.info('Server closed due to unhandled rejection');
    process.exit(1);
  });
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`, { stack: err.stack });
  // Close server with failure
  server.close(() => {
    logger.info('Server closed due to uncaught exception');
    process.exit(1);
  });
});
