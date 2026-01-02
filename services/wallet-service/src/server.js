require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const walletRoutes = require('./routes/walletRoutes');
const logger = require('./utils/logger');
const { startWalletConsumers } = require('./kafka/walletConsumers');
const { ensureSystemAndPlatformWallets } = require('./utils/walletBootstrap');

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

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'wallet-service', env: NODE_ENV, timestamp: new Date().toISOString() });
});

app.use('/', walletRoutes);

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

const PORT = process.env.PORT || 3002;

// Start HTTP server
app.listen(PORT, () => {
  logger.info(`Wallet Service running on port ${PORT}`);
  logger.info(`Environment: ${NODE_ENV}`);
});

ensureSystemAndPlatformWallets(require('./config/db').prisma).catch((err) => {
  logger.error({ err }, '[walletBootstrap] Failed to ensure system/platform wallets');
});

// Start Kafka consumers (do not await to avoid blocking startup)
startWalletConsumers().catch((err) => {
  logger.error('Failed to start wallet Kafka consumers:', err);
});

module.exports = app;
