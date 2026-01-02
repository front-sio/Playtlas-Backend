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

app.use(helmet());
app.use(cors());
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
