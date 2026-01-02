// Central environment config for all backend microservices.
// Each service still has its OWN .env with DATABASE_URL, KAFKA_CLIENT_ID.
//
// We try to load .env files via dotenv if it is installed, but do not crash
// if it is missing (e.g. when env vars are injected by the process manager).

try {
  // eslint-disable-next-line global-require
  require('dotenv').config();
} catch (err) {
  // Optional dependency – it's fine if this fails in production containers.
  // Services are expected to have env vars provided by the runtime.
  // eslint-disable-next-line no-console
  console.warn('[shared/env] dotenv not installed, skipping .env loading');
}

// Global fallback DB URL (used if service-specific URLs are not provided)
const GLOBAL_DATABASE_URL = process.env.DATABASE_URL || '';

// Helper to resolve a service-specific database URL with optional global fallback.
function resolveServiceDatabaseUrl(envVarName) {
  return process.env[envVarName] || GLOBAL_DATABASE_URL || '';
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 3000),

  // Global DB URL (not usually used directly by services, but available as a fallback)
  DATABASE_URL: GLOBAL_DATABASE_URL,

  // Per-service database URLs (each may fall back to the global DATABASE_URL if set)
  AUTH_DATABASE_URL: resolveServiceDatabaseUrl('AUTH_DATABASE_URL'),
  WALLET_DATABASE_URL: resolveServiceDatabaseUrl('WALLET_DATABASE_URL'),
  TOURNAMENT_DATABASE_URL: resolveServiceDatabaseUrl('TOURNAMENT_DATABASE_URL'),
  GAME_DATABASE_URL: resolveServiceDatabaseUrl('GAME_DATABASE_URL'),
  ADMIN_DATABASE_URL: resolveServiceDatabaseUrl('ADMIN_DATABASE_URL'),
  PLAYER_DATABASE_URL: resolveServiceDatabaseUrl('PLAYER_DATABASE_URL'),
  NOTIFICATION_DATABASE_URL: resolveServiceDatabaseUrl('NOTIFICATION_DATABASE_URL'),
  MATCHMAKING_DATABASE_URL: resolveServiceDatabaseUrl('MATCHMAKING_DATABASE_URL'),
  PAYMENT_DATABASE_URL: resolveServiceDatabaseUrl('PAYMENT_DATABASE_URL'),

  KAFKA_BROKERS: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID || 'backend-service',
  KAFKA_GROUP_ID: process.env.KAFKA_GROUP_ID || undefined,

  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: Number(process.env.REDIS_PORT || 6379),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  REDIS_USERNAME: process.env.REDIS_USERNAME || undefined,
  REDIS_TLS: process.env.REDIS_TLS === 'true',
  REDIS_URL: process.env.REDIS_URL || undefined,

  JWT_SECRET: process.env.JWT_SECRET || undefined,

  EMAIL_SMTP_HOST: process.env.EMAIL_SMTP_HOST || undefined,
  EMAIL_SMTP_PORT: process.env.EMAIL_SMTP_PORT
    ? Number(process.env.EMAIL_SMTP_PORT)
    : undefined,
  EMAIL_SMTP_USER: process.env.EMAIL_SMTP_USER || undefined,
  EMAIL_SMTP_PASS: process.env.EMAIL_SMTP_PASS || undefined,

  SMS_PROVIDER_API_KEY: process.env.SMS_PROVIDER_API_KEY || undefined,

  // Financial configuration
  PLATFORM_FEE_PERCENTAGE: Number(process.env.PLATFORM_FEE_PERCENTAGE || 37),
  TOURNAMENT_WINNER_PAYOUT_PERCENTAGE: Number(process.env.TOURNAMENT_WINNER_PAYOUT_PERCENTAGE || 100)
};

if (!env.DATABASE_URL) {
  console.warn('[shared/env] DATABASE_URL is not set – per-service *_DATABASE_URL env vars will be used exclusively');
}

module.exports = { env, resolveServiceDatabaseUrl };
