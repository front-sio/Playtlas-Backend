// Common Drizzle ORM helpers (transactions, pagination, etc.).

/**
 * Execute a callback within a Drizzle transaction.
 *
 * Example:
 *   const { withTransaction } = require('../../shared/utils/drizzleHelpers');
 *   await withTransaction(db, async (tx) => {
 *     await tx.insert(wallets).values(...);
 *     await tx.insert(transactions).values(...);
 *   });
 */
async function withTransaction(db, fn) {
  return db.transaction(async (tx) => {
    return fn(tx);
  });
}

/**
 * Simple pagination calculator.
 */
function getPagination(params) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.max(1, Math.min(Number(params.pageSize) || 20, 100));
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

module.exports = {
  withTransaction,
  getPagination
};