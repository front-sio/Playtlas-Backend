const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');

// Load environment variables FIRST before any database imports
dotenv.config();

const paymentRoutes = require('./routes/payment.js');
const { logger } = require('./utils/logger.js');
const { testConnection, prisma } = require('./config/db.js');
const cron = require('node-cron');
const { getProvider } = require('./providers/index.js');
const paymentProcessingService = require('./services/paymentProcessing.js');

const app = express();
const PORT = process.env.PORT || 3003;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Routes
app.use('/', paymentRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Cron jobs
// Check pending deposits and query status (every 2 minutes)
cron.schedule('*/2 * * * *', async () => {
  try {
    const pendingDeposits = await prisma.deposit.findMany({
      where: {
        status: 'processing',
        createdAt: {
          gt: new Date(Date.now() - 30 * 60 * 1000) // 30 minutes ago
        }
      },
      take: 50
    });

    for (const deposit of pendingDeposits) {
      if (deposit.externalReference) {
        const provider = getProvider(deposit.provider);
        const result = await provider.queryTransaction(deposit.externalReference);

        if (result.success && result.status === 'completed') {
          await prisma.deposit.update({
            where: { depositId: deposit.depositId },
            data: { status: 'completed', completedAt: new Date() }
          });

          await paymentProcessingService.creditWallet({
            walletId: deposit.walletId,
            amount: deposit.amount,
            referenceNumber: deposit.referenceNumber,
            description: `Deposit via ${deposit.provider}`
          });

          await paymentProcessingService.sendNotification({
            userId: deposit.userId,
            type: 'payment',
            title: 'Deposit Completed',
            message: `Your deposit of ${deposit.amount} TZS has been completed`
          });

          logger.info('Deposit auto-completed via cron:', { depositId: deposit.depositId });
        }
      }
    }
  } catch (error) {
    logger.error('Deposit status check cron failed:', error);
  }
});

// Expire old pending deposits (every 5 minutes)
cron.schedule('*/5 * * * *', async () => {
  try {
    await prisma.deposit.updateMany({
      where: {
        status: 'pending',
        expiresAt: {
          lt: new Date()
        }
      },
      data: { status: 'expired' }
    });
  } catch (error) {
    logger.error('Deposit expiration cron failed:', error);
  }
});

// Check pending withdrawals and query status (every 3 minutes)
cron.schedule('*/3 * * * *', async () => {
  try {
    const pendingWithdrawals = await prisma.withdrawal.findMany({
      where: {
        status: 'processing',
        createdAt: {
          gt: new Date(Date.now() - 60 * 60 * 1000) // 1 hour ago
        }
      },
      take: 50
    });

    for (const withdrawal of pendingWithdrawals) {
      if (withdrawal.externalReference) {
        const provider = getProvider(withdrawal.provider);
        const result = await provider.queryTransaction(withdrawal.externalReference);

        if (result.success && result.status === 'completed') {
          await prisma.withdrawal.update({
            where: { withdrawalId: withdrawal.withdrawalId },
            data: { status: 'completed', completedAt: new Date() }
          });

          await paymentProcessingService.sendNotification({
            userId: withdrawal.userId,
            type: 'payment',
            title: 'Withdrawal Completed',
            message: `Your withdrawal of ${withdrawal.amount} TZS has been completed`
          });

          logger.info('Withdrawal auto-completed via cron:', { withdrawalId: withdrawal.withdrawalId });
        } else if (result.success && result.status === 'failed') {
          // Refund on failure
          await prisma.withdrawal.update({
            where: { withdrawalId: withdrawal.withdrawalId },
            data: { status: 'failed' }
          });

          await paymentProcessingService.creditWallet({
            walletId: withdrawal.walletId,
            amount: withdrawal.totalDeducted,
            referenceNumber: `REFUND-${withdrawal.referenceNumber}`,
            description: 'Refund for failed withdrawal'
          });

          logger.warn('Withdrawal failed, wallet refunded:', { withdrawalId: withdrawal.withdrawalId });
        }
      }
    }
  } catch (error) {
    logger.error('Withdrawal status check cron failed:', error);
  }
});

// Start server
const startServer = async () => {
  try {
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      throw new Error('Database connection failed');
    }

    app.listen(PORT, () => {
      logger.info(`💳 Payment Service running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`Supported providers: Vodacom M-Pesa, Tigo Pesa, Airtel Money, HaloPesa`);
      logger.info(`Fraud detection: Active`);
      logger.info(`Auto-status check: Active (deposits: 2min, withdrawals: 3min)`);
    });
  } catch (error) {
    logger.error('Failed to start payment service:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

startServer();
