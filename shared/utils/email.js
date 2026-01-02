// Placeholder email helper using Nodemailer.

const nodemailer = require('nodemailer');
const { env } = require('../config/env');
const { logger } = require('./logger');

let transporter = null;

/**
 * Lazily create and reuse Nodemailer transporter.
 */
function getTransporter() {
  if (!transporter) {
    if (!env.EMAIL_SMTP_HOST || !env.EMAIL_SMTP_USER || !env.EMAIL_SMTP_PASS) {
      throw new Error('[email] SMTP credentials are not fully configured');
    }

    transporter = nodemailer.createTransport({
      host: env.EMAIL_SMTP_HOST,
      port: env.EMAIL_SMTP_PORT || 587,
      secure: false,
      auth: {
        user: env.EMAIL_SMTP_USER,
        pass: env.EMAIL_SMTP_PASS
      }
    });
  }
  return transporter;
}

/**
 * Send an email (used typically from Notification service via BullMQ).
 */
async function sendEmail(options) {
  const transport = getTransporter();
  const from = options.from || env.EMAIL_SMTP_USER;
  await transport.sendMail({
    from,
    to: options.to,
    subject: options.subject,
    text: options.text,
    html: options.html
  });

  logger.info({ to: options.to, subject: options.subject }, '[email] Sent email');
}

module.exports = {
  sendEmail
};