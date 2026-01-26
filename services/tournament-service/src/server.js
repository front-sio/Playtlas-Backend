require('dotenv').config();

const originalSetTimeout = global.setTimeout;
global.setTimeout = (fn, delay, ...args) => {
  const safeDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
  return originalSetTimeout(fn, safeDelay, ...args);
};
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const tournamentRoutes = require('./routes/tournamentRoutes');
const playerApiRoutes = require('./routes/playerApi');
const logger = require('./utils/logger');
const { startTournamentCommandConsumer } = require('./kafka/commandConsumer');
const { startSeasonCancellationConsumer } = require('./kafka/seasonCancellationConsumer');
const { startSchedulerWorker, ensureActiveTournamentSchedules } = require('./jobs/schedulerQueue');

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

app.use('/tournament', tournamentRoutes);
app.use('/tournament/player', playerApiRoutes);
// AI routes disabled
// // app.use('/api', require('./routes/aiTournaments'));

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'tournament-service', timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Tournament Service running on port ${PORT}`);
  // BullMQ scheduler worker for seasons/fixtures (safe to start early)
  startSchedulerWorker().catch((err) => {
    logger.error({ err }, '[tournament-service] Failed to start scheduler worker');
  });
  ensureActiveTournamentSchedules().catch((err) => {
    logger.error({ err }, '[tournament-service] Failed to ensure active tournament schedules');
  });
  // Kafka consumer for admin-driven tournament commands
  startTournamentCommandConsumer().catch((err) => {
    logger.error({ err }, '[tournament-service] Failed to start command consumer');
  });
  // Kafka consumer for season completion payouts (loaded dynamically)
  (async () => {
    try {
      const { startSeasonCompletionConsumer } = require('./kafka/seasonCompletionConsumer');
      await startSeasonCompletionConsumer();
    } catch (err) {
      logger.error({ err }, '[tournament-service] Failed to start season completion consumer');
    }
  })();
  // Kafka consumer for match generation confirmations
  (async () => {
    try {
      const { startSeasonMatchGenerationConsumer } = require('./kafka/seasonMatchGenerationConsumer');
      await startSeasonMatchGenerationConsumer();
    } catch (err) {
      logger.error({ err }, '[tournament-service] Failed to start season match generation consumer');
    }
  })();
  // Kafka consumer for season cancellation (insufficient players)
  startSeasonCancellationConsumer().catch((err) => {
    logger.error({ err }, '[tournament-service] Failed to start season cancellation consumer');
  });
});

module.exports = app;
