const { createWorkerWithDlq } = require('../../../../shared/config/redis');
const { QueueNames } = require('../../../../shared/constants/queueNames');
const { generateOtp, getOtpExpiry } = require('../../../../shared/utils/otp');
const { enqueueNotification } = require('../../../../shared/utils/notificationHelper');
const logger = require('../utils/logger');

function startOtpWorker() {
  const deadLetterQueueName = QueueNames.AUTH_OTP + '-dlq';
  const concurrency = Number(process.env.AUTH_OTP_CONCURRENCY || 5);

  const worker = createWorkerWithDlq(
    QueueNames.AUTH_OTP,
    async (job) => {
      const { userId, channel, destination, code } = job.data || {};
      if (!userId || !channel) {
        throw new Error('userId and channel are required for OTP job');
      }

      if (!code) {
        throw new Error('code is required for OTP job');
      }

      const expiresAt = getOtpExpiry(10);

      // Send notification with the actual code from the database
      await enqueueNotification({
        userId,
        channel,
        type: 'otp',
        title: 'Your verification code',
        message: `Your verification code is ${code}`,
        email: channel === 'email' ? destination : undefined,
        phone: channel === 'sms' ? destination : undefined,
        data: { expiresAt, destination, code }
      });

      logger.info({ jobId: job.id, userId, channel, action: 'otp_generated' }, '[auth-otp-worker] OTP generated and notification enqueued');
    },
    { concurrency, deadLetterQueueName }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job && job.id, err }, '[auth-otp-worker] Job failed');
  });

  return worker;
}

module.exports = {
  startOtpWorker
};
