const nodemailer = require('nodemailer');
const axios = require('axios');
const logger = require('../utils/logger');

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }

  async sendViaMailjet(to, subject, html, text) {
    const apiKey = process.env.MAILJET_API_KEY;
    const apiSecret = process.env.MAILJET_API_SECRET;
    if (!apiKey || !apiSecret) return null;

    const fromEmail = process.env.MAIL_FROM_EMAIL || 'noreply@poolgame.com';
    const fromName = process.env.MAIL_FROM_NAME || 'Pool Table Game';

    const payload = {
      Messages: [
        {
          From: { Email: fromEmail, Name: fromName },
          To: [{ Email: to }],
          Subject: subject,
          TextPart: text || subject,
          HTMLPart: html || text || subject
        }
      ]
    };

    const authHeader = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    const response = await axios.post('https://api.mailjet.com/v3.1/send', payload, {
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    logger.info(`Mailjet email sent: ${response.data?.Messages?.[0]?.To?.[0]?.Email || to}`);
    return { success: true, provider: 'mailjet', response: response.data };
  }

  async send(to, subject, html, text) {
    try {
      if (process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET) {
        return await this.sendViaMailjet(to, subject, html, text);
      }

      if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        logger.warn('Email service not configured, skipping email send');
        return { success: true, simulated: true };
      }

      const info = await this.transporter.sendMail({
        from: process.env.SMTP_FROM || '"Pool Table Game" <noreply@poolgame.com>',
        to,
        subject,
        text,
        html
      });

      logger.info(`Email sent: ${info.messageId}`);
      logger.info(`SMTP Response: ${info.response}`);
      logger.info(`Accepted: ${JSON.stringify(info.accepted)}`);
      logger.info(`Rejected: ${JSON.stringify(info.rejected)}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      logger.error('Email send error:', error);
      throw error;
    }
  }

  async sendTemplate(to, templateName, variables) {
    // Simple template rendering (replace with proper template engine if needed)
    const templates = {
      'welcome': {
        subject: 'Welcome to Pool Table Game!',
        html: `<h1>Welcome ${variables.username}!</h1><p>Your account has been created successfully.</p>`
      },
      'tournament_started': {
        subject: 'Tournament Started',
        html: `<h1>Tournament ${variables.tournamentName} has started!</h1><p>Good luck!</p>`
      },
      'match_reminder': {
        subject: 'Match Reminder',
        html: `<h1>Your match starts in ${variables.minutes} minutes!</h1><p>Get ready!</p>`
      },
      'prize_won': {
        subject: 'Congratulations! You Won!',
        html: `<h1>Congratulations!</h1><p>You won ${variables.amount} TZS in ${variables.tournamentName}!</p>`
      },
      'payment_received': {
        subject: 'Payment Received',
        html: `<h1>Payment Confirmed</h1><p>Amount: ${variables.amount} TZS</p>`
      }
    };

    const template = templates[templateName];
    if (!template) {
      throw new Error(`Template ${templateName} not found`);
    }

    return await this.send(to, template.subject, template.html, template.html.replace(/<[^>]*>/g, ''));
  }
}

module.exports = new EmailService();
