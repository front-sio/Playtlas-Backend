const axios = require('axios');
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { subscribeEvents, Topics } = require('../../../../shared/events');

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3007';
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

async function ensureAgentProfile(userId) {
  return prisma.agentProfile.upsert({
    where: { userId },
    update: { userId },
    create: { userId }
  });
}

async function handleAgentRegistered(payload) {
  const { userId } = payload || {};
  if (!userId) return;

  await ensureAgentProfile(userId);
  await ensureAgentWallet(userId);
}

async function handlePlayerJoinedSeason(payload) {
  const { playerId, seasonId } = payload;
  if (!playerId || !seasonId) return;

  const agentPlayer = await prisma.agentPlayer.findUnique({
    where: { playerId }
  });
  if (!agentPlayer) return;

  await prisma.agentSeasonPlayer.upsert({
    where: { agentId_seasonId_playerId: { agentId: agentPlayer.agentId, seasonId, playerId } },
    update: {},
    create: { agentId: agentPlayer.agentId, seasonId, playerId }
  });
}

async function handleSeasonCompleted(payload) {
  const { seasonId } = payload;
  if (!seasonId) return;

  const seasonPlayers = await prisma.agentSeasonPlayer.findMany({
    where: { seasonId }
  });

  const grouped = seasonPlayers.reduce((acc, row) => {
    acc[row.agentId] = (acc[row.agentId] || 0) + 1;
    return acc;
  }, {});

  const agentIds = Object.keys(grouped);
  for (const agentId of agentIds) {
    const playerCount = grouped[agentId];
    if (playerCount <= 0) continue;

    const existing = await prisma.agentSeasonPayout.findUnique({
      where: { agentId_seasonId: { agentId, seasonId } }
    });
    if (existing) continue;

    const agent = await prisma.agentProfile.findUnique({ where: { agentId } });
    if (!agent) continue;

    const amount = Number((playerCount * AGENT_PAYOUT_RATE).toFixed(2));
    const wallet = await ensureAgentWallet(agent.userId);

    await axios.post(`${WALLET_SERVICE_URL}/credit`, {
      walletId: wallet.walletId,
      amount,
      description: `Agent season payout for ${playerCount} players`,
      metadata: { seasonId, agentId, playerCount }
    });

    await prisma.agentSeasonPayout.create({
      data: {
        agentId,
        seasonId,
        playerCount,
        amount,
        status: 'paid',
        paidAt: new Date()
      }
    });

    logger.info({ agentId, seasonId, playerCount, amount }, '[agent] Season payout completed');
  }
}

async function startAgentConsumers() {
  let attempt = 0;
  // Keep retrying so payouts/registrations resume if Kafka starts late.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await subscribeEvents(
        'agent-service',
        [Topics.AGENT_REGISTERED, Topics.PLAYER_JOINED_SEASON, Topics.SEASON_COMPLETED],
        async (topic, payload) => {
          const startTime = Date.now();
          try {
            if (topic === Topics.AGENT_REGISTERED) {
              await handleAgentRegistered(payload);
            }
            if (topic === Topics.PLAYER_JOINED_SEASON) {
              await handlePlayerJoinedSeason(payload);
            }
            if (topic === Topics.SEASON_COMPLETED) {
              await handleSeasonCompleted(payload);
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
