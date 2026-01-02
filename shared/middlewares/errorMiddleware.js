// Global error handler for Express.

const { logger } = require('../utils/logger');

/**
 * Custom application error that can carry statusCode and details.
 */
class AppError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.statusCode = statusCode || 500;
    this.details = details;
  }
}

/**
 * Error-handling middleware – must be the last middleware.
 */
function errorMiddleware(err, _req, res, _next) {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let details;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details;
  } else if (err instanceof Error) {
    message = err.message;
  }

  logger.error(
    { err, statusCode, details },
    '[errorMiddleware] Unhandled error'
  );

  res.status(statusCode).json({
    message,
    ...(details ? { details } : {})
  });
}

module.exports = {
  AppError,
  errorMiddleware
};