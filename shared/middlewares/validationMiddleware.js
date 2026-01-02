// Request validation middlewares using Zod.

const { ZodError } = require('zod');

/**
 * Validate req.body against a Zod schema.
 */
function validateBody(schema) {
  return function (req, res, next) {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          message: 'Invalid request body',
          errors: err.errors
        });
      }
      next(err);
    }
  };
}

/**
 * Validate req.query against a Zod schema.
 */
function validateQuery(schema) {
  return function (req, res, next) {
    try {
      req.query = schema.parse(req.query);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          message: 'Invalid query params',
          errors: err.errors
        });
      }
      next(err);
    }
  };
}

module.exports = {
  validateBody,
  validateQuery
};