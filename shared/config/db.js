// Drizzle ORM + pg pool helper shared across all services.
//
// NOTE: Most services use postgres-js with their own local db config. This
// helper is optional and only required if a service explicitly calls
// createPool/createDb. To avoid hard dependencies, we load 'pg' lazily.

let Pool;
let drizzlePg;

try {
  // eslint-disable-next-line global-require
  ({ Pool } = require('pg'));
  // eslint-disable-next-line global-require
  drizzlePg = require('drizzle-orm/node-postgres').drizzle;
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[shared/db] pg or drizzle-orm/node-postgres not installed; shared DB helper will be unavailable');
}

const { env } = require('./env');

/**
 * Create a pg.Pool using given URL or env.DATABASE_URL.
 */
function createPool(databaseUrl) {
  if (!Pool) {
    throw new Error('[shared/db] pg is not installed. Either install pg or use a service-specific db config.');
  }

  const connectionString = databaseUrl || env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('[shared/db] DATABASE_URL is not configured');
  }
  return new Pool({ connectionString });
}

/**
 * Create a Drizzle database instance.
 *
 * @param {object} schema - Drizzle schema for the service (require('../db/schema')).
 * @param {string} [databaseUrl] - Optional override of DATABASE_URL.
 */
function createDb(schema, databaseUrl) {
  if (!drizzlePg) {
    throw new Error('[shared/db] drizzle-orm/node-postgres is not available.');
  }
  const pool = createPool(databaseUrl);
  return drizzlePg(pool, { schema });
}

module.exports = {
  createPool,
  createDb
};
