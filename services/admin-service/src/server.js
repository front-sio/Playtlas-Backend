require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const adminRoutes = require('./routes/adminRoutes');
const approvalRoutes = require('./routes/tournamentApprovalRoutes');
const logger = require('./utils/logger');
const { errorHandler } = require('./middlewares/errorHandler');
const { startTournamentLifecycleConsumer } = require('./kafka/tournamentLifecycleConsumer');
const { startTournamentReadModelConsumer } = require('./kafka/tournamentReadModelConsumer');
const { startTournamentCommandResponseConsumer } = require('./kafka/tournamentCommandClient');
const { startAdminNotificationConsumer } = require('./kafka/adminNotificationConsumer');
const { authMiddleware } = require('../../../shared/middlewares/authMiddleware');

const app = express();
const NODE_ENV = process.env.NODE_ENV || 'development';

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
app.use(cors({ origin: resolveCorsOrigin, credentials: true }));
app.use(express.json());

app.use('/', authMiddleware, adminRoutes);
app.use('/approvals', authMiddleware, approvalRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'admin-service', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3070;
app.listen(PORT, () => {
  logger.info(`Admin Service running on port ${PORT}`);
  startTournamentLifecycleConsumer().catch((err) => {
    logger.error({ err }, '[admin-service] Failed to start tournament lifecycle consumer');
  });
  startTournamentReadModelConsumer().catch((err) => {
    logger.error({ err }, '[admin-service] Failed to start tournament read-model consumer');
  });
  startTournamentCommandResponseConsumer();
  startAdminNotificationConsumer().catch((err) => {
    logger.error({ err }, '[admin-service] Failed to start admin notification consumer');
  });
});

module.exports = app;
