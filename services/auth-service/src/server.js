require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const authRoutes = require('./routes/authRoutes');
const logger = require('./utils/logger');
const { startOtpWorker } = require('./jobs/otpWorker');
const { startAuthConsumers } = require('./kafka/consumers');

const NODE_ENV = process.env.NODE_ENV || 'development';
const app = express();

if (NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const parseOrigins = (value) => (value || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = parseOrigins(process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || '');
const DEFAULT_DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const getDefaultOrigins = () => (NODE_ENV === 'production' ? [] : DEFAULT_DEV_ORIGINS);
const resolveCorsOrigin = (origin, callback) => {
  const targetOrigins = allowedOrigins.length > 0 ? allowedOrigins : getDefaultOrigins();
  if (!origin) return callback(null, true);
  if (targetOrigins.includes('*') || targetOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Not allowed by CORS'));
};

app.use(helmet());
app.use(
  cors({
    origin: resolveCorsOrigin,
    credentials: true
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

app.use('/', authRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'auth-service', env: NODE_ENV, timestamp: new Date().toISOString() });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Auth Service running on port ${PORT}`);
  logger.info(`Environment: ${NODE_ENV}`);
});

// Start OTP worker for auth-related OTP sending
startOtpWorker();
startAuthConsumers().catch(err => logger.error('Failed to start auth consumers', err));

module.exports = app;
