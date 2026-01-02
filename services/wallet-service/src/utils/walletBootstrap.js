const logger = require('./logger');

const SYSTEM_OWNER_ID = process.env.SYSTEM_OWNER_ID || '00000000-0000-0000-0000-000000000000';
const SYSTEM_WALLET_ID = process.env.SYSTEM_WALLET_ID || null;
const PLATFORM_WALLET_ID = process.env.PLATFORM_WALLET_ID || null;

async function findOrCreateWallet(db, { type, walletId, ownerId }) {
  let wallet = null;

  if (walletId) {
    wallet = await db.wallet.findUnique({ where: { walletId } });
    if (wallet && wallet.type !== type) {
      logger.warn({ walletId, type, existingType: wallet.type }, '[walletBootstrap] Wallet ID exists with different type');
      return wallet;
    }
  }

  if (!wallet) {
    wallet = await db.wallet.findFirst({ where: { type } });
    if (wallet && walletId && wallet.walletId !== walletId) {
      logger.warn({ type, walletId, existingWalletId: wallet.walletId }, '[walletBootstrap] Wallet type exists with different ID');
    }
  }

  if (wallet) return wallet;

  const data = {
    ownerId,
    type,
    currency: 'TZS',
    balance: 0
  };

  if (walletId) data.walletId = walletId;

  wallet = await db.wallet.create({ data });
  logger.info({ walletId: wallet.walletId, type }, '[walletBootstrap] Wallet created');
  return wallet;
}

async function ensureSystemWallet(db) {
  return findOrCreateWallet(db, {
    type: 'system',
    walletId: SYSTEM_WALLET_ID,
    ownerId: SYSTEM_OWNER_ID
  });
}

async function ensurePlatformWallet(db) {
  return findOrCreateWallet(db, {
    type: 'platform',
    walletId: PLATFORM_WALLET_ID,
    ownerId: SYSTEM_OWNER_ID
  });
}

async function ensureSystemAndPlatformWallets(db) {
  const system = await ensureSystemWallet(db);
  const platform = await ensurePlatformWallet(db);
  return { system, platform };
}

module.exports = {
  SYSTEM_OWNER_ID,
  SYSTEM_WALLET_ID,
  PLATFORM_WALLET_ID,
  findOrCreateWallet,
  ensureSystemWallet,
  ensurePlatformWallet,
  ensureSystemAndPlatformWallets
};
