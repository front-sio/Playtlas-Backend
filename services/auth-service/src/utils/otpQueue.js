const { createQueue, defaultJobOptions } = require('../../../../shared/config/redis');
const { QueueNames } = require('../../../../shared/constants/queueNames');
const logger = require('./logger');

let otpQueue;

function getOtpQueue() {
  if (!otpQueue) {
    otpQueue = createQueue(QueueNames.AUTH_OTP);
  }
  return otpQueue;
}

async function enqueueOtpJob(payload, opts = {}) {
  const queue = getOtpQueue();
  const jobOpts = { ...defaultJobOptions, ...opts };
  const job = await queue.add('auth-otp', payload, jobOpts);
  logger.info({ jobId: job.id, userId: payload.userId }, '[auth-otp-queue] OTP job enqueued');
  return job;
}

module.exports = {
  enqueueOtpJob
};