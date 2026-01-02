// Placeholder SMS helper. Integrate Twilio/SNS/etc. here.

const { env } = require('../config/env');
const { logger } = require('./logger');

/**
 * Send an SMS (stub).
 */
async function sendSms(options) {
  if (!env.SMS_PROVIDER_API_KEY) {
    logger.warn(
      { to: options.to },
      '[sms] SMS_PROVIDER_API_KEY not configured; not actually sending SMS'
    );
    return;
  }

  // TODO: integrate with real SMS provider HTTP API or SDK.
  logger.info({ to: options.to, message: options.message }, '[sms] Sending SMS (stub)');
}

module.exports = {
  sendSms
};