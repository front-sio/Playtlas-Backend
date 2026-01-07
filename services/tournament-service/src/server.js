require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const tournamentRoutes = require('./routes/tournamentRoutes');
const logger = require('./utils/logger');
const { startTournamentCommandConsumer } = require('./kafka/commandConsumer');
const { startSeasonCompletionConsumer } = require('./kafka/seasonCompletionConsumer');
const { startSeasonCancellationConsumer } = require('./kafka/seasonCancellationConsumer');
const { startSchedulerWorker, ensureActiveTournamentSchedules } = require('./jobs/schedulerQueue');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/tournament', tournamentRoutes);

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
  // Kafka consumer for season completion payouts
  startSeasonCompletionConsumer().catch((err) => {
    logger.error({ err }, '[tournament-service] Failed to start season completion consumer');
  });
  // Kafka consumer for season cancellation (insufficient players)
  startSeasonCancellationConsumer().catch((err) => {
    logger.error({ err }, '[tournament-service] Failed to start season cancellation consumer');
  });
});

module.exports = app;
