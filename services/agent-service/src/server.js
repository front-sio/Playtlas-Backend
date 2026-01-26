require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const agentRoutes = require('./routes/agentRoutes');
const logger = require('./utils/logger');
const { startAgentConsumers } = require('./kafka/agentConsumer');
const { DailyEarningsJob } = require('./jobs/DailyEarningsJob');

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

app.use('/', agentRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'agent-service', env: NODE_ENV, timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  logger.info(`Agent Service running on port ${PORT}`);
  logger.info(`Environment: ${NODE_ENV}`);
});

startAgentConsumers().catch((err) => {
  logger.error({ err }, '[agent-service] Failed to start Kafka consumers');
});

if (process.env.DISABLE_DAILY_EARNINGS_JOB !== 'true') {
  try {
    const dailyJob = new DailyEarningsJob();
    dailyJob.start();
  } catch (error) {
    logger.error({ err: error }, '[agent-service] Failed to start daily earnings job');
  }
}

module.exports = app;
