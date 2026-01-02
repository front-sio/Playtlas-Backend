const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default_32_char_key_change_me!!';
const ALGORITHM = 'aes-256-cbc';

const encrypt = (text) => {
  try {
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (error) {
    throw new Error('Encryption failed');
  }
};

const decrypt = (encryptedText) => {
  try {
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    throw new Error('Decryption failed');
  }
};

const hashData = (data) => {
  return crypto.createHash('sha256').update(data).digest('hex');
};

const verifyWebhookSignature = (payload, signature, secret) => {
  const expectedSignature = crypto
    .createHmac('sha256', secret || process.env.WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
};

const generateReference = (prefix = 'PAY') => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
};

const maskPhoneNumber = (phone) => {
  if (!phone || phone.length < 6) {
    return phone;
  }
  return phone.slice(0, 3) + '****' + phone.slice(-3);
};

const sanitizePhoneNumber = (phone) => {
  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, '');
  
  // Handle Tanzania format (255...)
  if (cleaned.startsWith('255')) {
    return cleaned;
  }
  
  // Handle local format (0...) - convert to international
  if (cleaned.startsWith('0')) {
    return '255' + cleaned.slice(1);
  }
  
  // Assume it needs 255 prefix
  return '255' + cleaned;
};

module.exports = {
  encrypt,
  decrypt,
  hashData,
  verifyWebhookSignature,
  generateReference,
  maskPhoneNumber,
  sanitizePhoneNumber
};
