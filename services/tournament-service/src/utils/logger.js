const winston = require('winston');

const serialize = (value) => {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  if (typeof value === 'object' && value !== null) {
    return value;
  }
  return value;
};

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const normalizedMessage =
        typeof message === 'string' ? message : JSON.stringify(serialize(message));
      const metaKeys = Object.keys(meta);
      const metaPayload = metaKeys.length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} ${level}: ${normalizedMessage}${metaPayload}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

module.exports = logger;
