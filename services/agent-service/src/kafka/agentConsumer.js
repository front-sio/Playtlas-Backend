const axios = require('axios');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, Topics } = require('../../../../shared/events');

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002';
const AGENT_PAYOUT_RATE = Number(process.env.AGENT_PAYOUT_PER_PLAYER || 200);

function logProcessingResult(topic, startTime, err) {
  const durationMs = Date.now() - startTime;
  if (err) {
    logger.error({ topic, durationMs, err }, '[agent-consumers] Event processing failed');
    return;
  }
  if (durationMs > 2000) {
    logger.warn({ topic, durationMs }, '[agent-consumers] Slow event processing');
  } else {
    logger.info({ topic, durationMs }, '[agent-consumers] Event processed');
  }
}

async function ensureAgentWallet(ownerId) {
  try {
    const walletResponse = await axios.get(`${WALLET_SERVICE_URL}/owner/${ownerId}`, {
      params: { type: 'agent' }
    });
    if (walletResponse.data?.data?.walletId) return walletResponse.data.data;
  } catch (error) {
    if (error.response?.status !== 404) {
      throw error;
    }
  }

  const created = await axios.post(`${WALLET_SERVICE_URL}/create`, {
    userId: ownerId,
    type: 'agent',
    currency: 'TZS'
  });
  return created.data?.data;
}

async function ensureAgentProfile(userId, clubId) {
  if (!clubId) {
    throw new Error('clubId is required to create agent profile');
  }
  return prisma.agentProfile.upsert({
    where: { userId },
    update: { clubId },
    create: { userId, clubId }
  });
}

async function handleAgentRegistered(payload) {
  const { userId, clubId } = payload || {};
  if (!userId) return;
  if (!clubId) {
    logger.warn({ payload }, '[agent-consumers] AGENT_REGISTERED missing clubId');
    return;
  }

  await ensureAgentProfile(userId, clubId);
  await ensureAgentWallet(userId);
}

async function startAgentConsumers() {
  let attempt = 0;
  // Keep retrying so payouts/registrations resume if Kafka starts late.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await subscribeEvents(
        'agent-service',
        [Topics.AGENT_REGISTERED],
        async (topic, payload) => {
          const startTime = Date.now();
          try {
            if (topic === Topics.AGENT_REGISTERED) {
              await handleAgentRegistered(payload);
            }
            logProcessingResult(topic, startTime);
          } catch (err) {
            logProcessingResult(topic, startTime, err);
          }
        }
      );
      return;
    } catch (err) {
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
      logger.error({ err, attempt, delay }, '[agent-consumers] Failed to subscribe to Kafka, retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = { startAgentConsumers };
