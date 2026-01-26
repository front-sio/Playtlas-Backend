require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const notificationRoutes = require('./routes/notificationRoutes');
const logger = require('./utils/logger');
const cron = require('node-cron');
const { prisma } = require('./config/db');
const { startNotificationWorkers } = require('./jobs/notificationWorkers');
const { startNotificationConsumers } = require('./kafka/notificationConsumers');

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

app.use('/notification', notificationRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'notification-service', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(err.statusCode || 500).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
});

// Retry failed notifications (every 5 minutes)
cron.schedule('*/5 * * * *', async () => {
  try {
    const failedNotifications = await prisma.notification.findMany({
      where: {
        status: 'failed',
        retryCount: { lt: 3 }
      },
      take: 100
    });

    logger.info(`Retrying ${failedNotifications.length} failed notifications`);

    for (const notification of failedNotifications) {
      // Retry logic would go here
      logger.info(`Retrying notification: ${notification.notificationId}`);
    }
  } catch (error) {
    logger.error('Retry job error:', error);
  }
});

const PORT = process.env.PORT || 3007;
app.listen(PORT, () => {
  logger.info(`Notification Service running on port ${PORT}`);
});

// Start BullMQ workers for notifications
startNotificationWorkers();

// Start Kafka consumers (non-blocking)
startNotificationConsumers().catch((err) => {
  logger.error('Failed to start notification Kafka consumers:', err);
});

module.exports = app;
