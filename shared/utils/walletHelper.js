// Shared wallet helper functions built on Drizzle ORM.
// These helpers are intentionally generic: callers must pass in
// the Drizzle db instance and the wallet-related tables.
//
// Design goals:
// - All operations are transactional (using Drizzle transactions).
// - Concurrency-safe balance updates using optimistic locking.
// - Optional idempotency via an idempotencyKey per logical operation.
// - Every balance change is recorded in the transactions ledger.

const { eq, and } = require('drizzle-orm');
const { logger } = require('./logger');
const { withTransaction } = require('./drizzleHelpers');
const { publishEvent, Topics } = require('../events');

function toAmountNumber(value) {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (Number.isNaN(n)) return 0;
  return n;
}

function toAmountString(value) {
  return toAmountNumber(value).toFixed(2);
}

async function findTransactionByIdempotency(db, { transactions }, idempotencyKey) {
  if (!idempotencyKey) return null;

  const existing = await db
    .select()
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idempotencyKey))
    .limit(1);

  return existing[0] || null;
}

/**
 * Create a wallet for a given owner.
 *
 * This helper is idempotent per (ownerId, type): if a wallet already exists
 * with the same owner and type, it is returned instead of inserting a new one.
 *
 * @param {any} db - Drizzle db instance.
 * @param {{ wallets: any }} tables - Drizzle tables.
 * @param {{ ownerId: string, type?: string, currency?: string, metadata?: any }} opts
 */
async function createWallet(db, { wallets }, opts) {
  const { ownerId, type = 'player', currency = 'TZS', metadata = null } = opts;

  return withTransaction(db, async (tx) => {
    const [existing] = await tx
      .select()
      .from(wallets)
      .where(and(eq(wallets.ownerId, ownerId), eq(wallets.type, type)))
      .limit(1);

    if (existing) {
      logger.info({ walletId: existing.walletId, ownerId, type }, '[walletHelper] Wallet already exists, returning existing');
      return existing;
    }

    const [wallet] = await tx
      .insert(wallets)
      .values({ ownerId, type, currency, metadata })
      .returning();

    logger.info({ walletId: wallet.walletId, ownerId, type }, '[walletHelper] Wallet created');
    return wallet;
  });
}

/**
 * Internal helper to mutate a wallet balance in a concurrency-safe way.
 *
 * direction: 'credit' | 'debit'
 */
async function mutateWalletBalance(db, { wallets, transactions }, opts) {
  const {
    walletId,
    amount,
    direction,
    type,
    description,
    metadata = null,
    idempotencyKey
  } = opts;

  if (!walletId) throw new Error('walletId is required');
  const delta = toAmountNumber(amount);
  if (delta <= 0) throw new Error('amount must be positive');

  return withTransaction(db, async (tx) => {
    // Idempotency: if a transaction with this key already exists, treat it as success.
    const existingTx = await findTransactionByIdempotency(tx, { transactions }, idempotencyKey);
    if (existingTx) {
      logger.info({ walletId, idempotencyKey }, '[walletHelper] Idempotent wallet mutation, returning existing transaction');
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.walletId, walletId))
        .limit(1);
      return { wallet, transaction: existingTx, idempotent: true };
    }

    const [existingWallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.walletId, walletId))
      .limit(1);

    if (!existingWallet) {
      throw new Error('Wallet not found');
    }

    const currentBalance = toAmountNumber(existingWallet.balance);
    let newBalance;

    if (direction === 'credit') {
      newBalance = toAmountString(currentBalance + delta);
    } else if (direction === 'debit') {
      if (currentBalance < delta) {
        throw new Error('Insufficient balance');
      }
      newBalance = toAmountString(currentBalance - delta);
    } else {
      throw new Error(`Unsupported direction: ${direction}`);
    }

    // Insert ledger transaction first.
    const [transaction] = await tx
      .insert(transactions)
      .values({
        fromWalletId: direction === 'debit' ? walletId : null,
        toWalletId: direction === 'credit' ? walletId : null,
        amount: toAmountString(delta),
        type,
        status: 'completed',
        description,
        metadata,
        idempotencyKey: idempotencyKey || null
      })
      .returning();

    // Optimistic locking on balance to avoid lost updates.
    const [updatedWallet] = await tx
      .update(wallets)
      .set({ balance: newBalance, updatedAt: new Date() })
      .where(and(eq(wallets.walletId, walletId), eq(wallets.balance, existingWallet.balance)))
      .returning();

    if (!updatedWallet) {
      // Another concurrent transaction modified the balance; surface an explicit error so callers can retry.
      throw new Error('Concurrent wallet modification detected, please retry');
    }

    const logContext = { walletId, amount: delta, direction, idempotencyKey: idempotencyKey || undefined };
    logger.info(logContext, '[walletHelper] Wallet mutation successful');

    return { wallet: updatedWallet, transaction, idempotent: false };
  });
}

/**
 * Credit a wallet and record a transaction.
 */
async function creditWallet(db, { wallets, transactions }, opts) {
  const {
    walletId,
    amount,
    type = 'credit',
    description = 'Wallet credit',
    metadata = null,
    idempotencyKey
  } = opts;

  return mutateWalletBalance(db, { wallets, transactions }, {
    walletId,
    amount,
    direction: 'credit',
    type,
    description,
    metadata,
    idempotencyKey
  });
}

/**
 * Debit a wallet with balance check and record a transaction.
 */
async function debitWallet(db, { wallets, transactions }, opts) {
  const {
    walletId,
    amount,
    type = 'debit',
    description = 'Wallet debit',
    metadata = null,
    idempotencyKey
  } = opts;

  return mutateWalletBalance(db, { wallets, transactions }, {
    walletId,
    amount,
    direction: 'debit',
    type,
    description,
    metadata,
    idempotencyKey
  });
}

/**
 * Transfer funds between two wallets in a single transaction.
 */
async function transferFunds(db, tables, opts) {
  const { fromWalletId, toWalletId, amount, metadata = null, idempotencyKey } = opts;

  if (!fromWalletId || !toWalletId) throw new Error('fromWalletId and toWalletId are required');

  // Use a higher-level transaction to ensure both debit and credit succeed or fail together.
  return withTransaction(db, async (tx) => {
    // Use derived idempotency keys for debit/credit legs to ensure overall idempotency.
    const debitKey = idempotencyKey ? `${idempotencyKey}:debit` : undefined;
    const creditKey = idempotencyKey ? `${idempotencyKey}:credit` : undefined;

    await debitWallet(tx, tables, {
      walletId: fromWalletId,
      amount,
      type: 'transfer_debit',
      description: `Transfer to ${toWalletId}`,
      metadata,
      idempotencyKey: debitKey
    });

    const result = await creditWallet(tx, tables, {
      walletId: toWalletId,
      amount,
      type: 'transfer_credit',
      description: `Transfer from ${fromWalletId}`,
      metadata,
      idempotencyKey: creditKey
    });

    logger.info({ fromWalletId, toWalletId, amount, idempotencyKey }, '[walletHelper] Transfer complete');
    return result;
  });
}

/**
 * Pay a tournament fee into the system wallet.
 */
async function payTournamentFee(db, tables, opts) {
  const {
    playerWalletId,
    systemWalletId,
    amount,
    tournamentId,
    seasonId,
    idempotencyKey
  } = opts;

  const total = toAmountNumber(amount);
  const metadata = { tournamentId, seasonId };

  // Wrap the full fee payment in a single transaction to ensure atomicity.
  const result = await withTransaction(db, async (tx) => {
    const txTables = tables;

    const baseKey = idempotencyKey || (tournamentId && seasonId ? `tournamentFee:${tournamentId}:${seasonId}` : undefined);

    // Debit player wallet once for full amount.
    await debitWallet(tx, txTables, {
      walletId: playerWalletId,
      amount: toAmountString(total),
      type: 'tournament_fee',
      description: `Tournament fee for ${tournamentId}`,
      metadata,
      idempotencyKey: baseKey ? `${baseKey}:debit` : undefined
    });

    // Credit system wallet if provided.
    if (systemWalletId) {
      await creditWallet(tx, txTables, {
        walletId: systemWalletId,
        amount: toAmountString(total),
        type: 'tournament_fee_system',
        description: `Tournament fee for ${tournamentId}`,
        metadata,
        idempotencyKey: baseKey ? `${baseKey}:system` : undefined
      });
    }

    return {
      total: toAmountString(total)
    };
  });

  // Notify other services that the season fee has been debited successfully.
  try {
    await publishEvent(Topics.SEASON_FEE_DEBITED, {
      playerWalletId,
      systemWalletId,
      amount: toAmountString(total),
      tournamentId,
      seasonId,
      breakdown: {
        systemAmount: toAmountString(total)
      }
    });
  } catch (err) {
    logger.error({ err, tournamentId, seasonId }, '[walletHelper] Failed to publish SEASON_FEE_DEBITED event');
  }

  return result;
}

module.exports = {
  createWallet,
  creditWallet,
  debitWallet,
  transferFunds,
  payTournamentFee
};
