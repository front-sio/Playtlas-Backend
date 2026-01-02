const axios = require('axios');
const logger = require('../utils/logger');

class SMSService {
  constructor() {
    this.apiKey = process.env.SMS_API_KEY;
    this.apiUrl = process.env.SMS_API_URL || 'https://api.smsgateway.tz/v1/send';
    this.twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
    this.twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    this.twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
  }

  async send(phoneNumber, message) {
    try {
      const formattedNumber = this.formatPhoneNumber(phoneNumber);
      if (this.twilioAccountSid && this.twilioAuthToken && this.twilioPhoneNumber) {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${this.twilioAccountSid}/Messages.json`;
        const body = new URLSearchParams({
          To: formattedNumber,
          From: this.twilioPhoneNumber,
          Body: message
        });
        const response = await axios.post(url, body.toString(), {
          auth: {
            username: this.twilioAccountSid,
            password: this.twilioAuthToken
          },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000
        });
        logger.info(`SMS sent via Twilio to ${phoneNumber}`);
        return { success: true, provider: 'twilio', response: response.data };
      }

      if (!this.apiKey) {
        logger.warn('SMS service not configured, simulating SMS send');
        logger.info(`[SIMULATED SMS] To: ${phoneNumber}, Message: ${message}`);
        return { success: true, simulated: true };
      }

      // This is a generic implementation - adjust for your SMS provider
      const response = await axios.post(this.apiUrl, {
        apiKey: this.apiKey,
        to: formattedNumber,
        message: message
      }, {
        timeout: 10000
      });

      logger.info(`SMS sent to ${phoneNumber}`);
      return { success: true, response: response.data };
    } catch (error) {
      logger.error('SMS send error:', error.message);
      if (error.response?.data) {
        logger.error('SMS provider response:', error.response.data);
      }
      throw error;
    }
  }

  async sendBulk(phoneNumbers, message) {
    const results = [];
    
    for (const number of phoneNumbers) {
      try {
        const result = await this.send(number, message);
        results.push({ phoneNumber: number, success: true, ...result });
      } catch (error) {
        results.push({ phoneNumber: number, success: false, error: error.message });
      }
    }

    return results;
  }

  formatPhoneNumber(phoneNumber) {
    // Remove spaces and non-numeric characters
    let cleaned = phoneNumber.replace(/\D/g, '');
    
    // Add Tanzania country code if not present
    if (!cleaned.startsWith('255')) {
      if (cleaned.startsWith('0')) {
        cleaned = '255' + cleaned.substring(1);
      } else if (cleaned.startsWith('7')) {
        cleaned = '255' + cleaned;
      }
    }

    return '+' + cleaned;
  }
}

module.exports = new SMSService();
