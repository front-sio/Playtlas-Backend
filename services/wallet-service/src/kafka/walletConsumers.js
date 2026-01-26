const { prisma } = require('../config/db');
const { subscribeEvents, Topics, publishEvent } = require('../../../../shared/events');
const logger = require('../utils/logger');

function logProcessingResult(topic, startTime, err) {
  const durationMs = Date.now() - startTime;
  if (err) {
    logger.error({ topic, durationMs, err }, '[walletConsumers] Event processing failed');
    return;
  }
  if (durationMs > 2000) {
    logger.warn({ topic, durationMs }, '[walletConsumers] Slow event processing');
  } else {
    logger.info({ topic, durationMs }, '[walletConsumers] Event processed');
  }
}

async function handleDepositApproved(_topic, payload) {
  const { depositId, walletId, userId, amount, referenceNumber, description } = payload;
  
  if (!walletId || !amount) {
    logger.warn({ payload }, '[walletConsumers] DEPOSIT_APPROVED missing required fields');
    return;
  }

  try {
    // Credit the wallet
    await prisma.wallet.update({
      where: { walletId },
      data: {
        balance: {
          increment: parseFloat(amount)
        }
      }
    });

    logger.info({ walletId, amount, depositId, referenceNumber }, '[walletConsumers] Wallet credited for deposit');

    // Optionally publish notification event
    try {
      await publishEvent(Topics.NOTIFICATION_SEND, {
        userId,
        channel: 'in-app',
        type: 'wallet_credited',
        title: 'Deposit Successful',
        message: `Your wallet has been credited with ${amount} TZS`
      });
    } catch (notifErr) {
      logger.error({ err: notifErr, userId }, '[walletConsumers] Failed to send deposit notification');
    }
  } catch (err) {
    logger.error({ err, walletId, amount, depositId }, '[walletConsumers] Failed to credit wallet for deposit');
    throw err;
  }
}

async function handleWithdrawalApproved(_topic, payload) {
  const { withdrawalId, walletId, userId, amount, referenceNumber, description } = payload;
  
  if (!walletId || !amount) {
    logger.warn({ payload }, '[walletConsumers] WITHDRAWAL_APPROVED missing required fields');
    return;
  }

  try {
    const withdrawalSource = String(payload.source || payload.withdrawalSource || payload.metadata?.source || '').toLowerCase();
    const debitRevenue = withdrawalSource === 'revenue';

    // Debit the wallet
    const updateData = {
      balance: {
        decrement: parseFloat(amount)
      }
    };
    if (debitRevenue) {
      updateData.revenueBalance = { decrement: parseFloat(amount) };
    }

    await prisma.wallet.update({
      where: { walletId },
      data: updateData
    });

    logger.info({ walletId, amount, withdrawalId, referenceNumber }, '[walletConsumers] Wallet debited for withdrawal');

    // Optionally publish notification event
    try {
      await publishEvent(Topics.NOTIFICATION_SEND, {
        userId,
        channel: 'in-app',
        type: 'wallet_debited',
        title: 'Withdrawal Processing',
        message: `Your withdrawal of ${amount} TZS is being processed`
      });
    } catch (notifErr) {
      logger.error({ err: notifErr, userId }, '[walletConsumers] Failed to send withdrawal notification');
    }
  } catch (err) {
    logger.error({ err, walletId, amount, withdrawalId }, '[walletConsumers] Failed to debit wallet for withdrawal');
    throw err;
  }
}

async function handlePlayerRegistered(_topic, payload) {
  const { userId } = payload;
  if (!userId) {
    logger.warn({ payload }, '[walletConsumers] PLAYER_REGISTERED missing userId');
    return;
  }

  try {
    // Check if wallet already exists
    const existing = await prisma.wallet.findFirst({
      where: {
        ownerId: userId,
        type: 'player'
      }
    });

    let wallet = existing;
    if (!wallet) {
      wallet = await prisma.wallet.create({
        data: {
          ownerId: userId,
          type: 'player',
          currency: 'TZS',
          balance: 0
        }
      });
      logger.info({ walletId: wallet.walletId, userId }, '[walletConsumers] Wallet created for new player');
    } else {
      logger.info({ walletId: wallet.walletId, userId }, '[walletConsumers] Wallet already exists for player');
    }

    // Emit wallet.wallet_created so other services (e.g. notification) can react.
    try {
      await publishEvent(Topics.WALLET_CREATED, {
        walletId: wallet.walletId,
        ownerId: wallet.ownerId,
        type: wallet.type,
        currency: wallet.currency
      });
    } catch (eventErr) {
      logger.error({ err: eventErr, userId }, '[walletConsumers] Failed to publish WALLET_CREATED event');
    }
  } catch (err) {
    logger.error({ err, userId }, '[walletConsumers] Failed to create wallet for new player');
  }
}

async function handleAgentRegistered(_topic, payload) {
  const { userId } = payload;
  if (!userId) {
    logger.warn({ payload }, '[walletConsumers] AGENT_REGISTERED missing userId');
    return;
  }

  try {
    const existing = await prisma.wallet.findFirst({
      where: {
        ownerId: userId,
        type: 'agent'
      }
    });

    let wallet = existing;
    if (!wallet) {
      wallet = await prisma.wallet.create({
        data: {
          ownerId: userId,
          type: 'agent',
          currency: 'TZS',
          balance: 0
        }
      });
      logger.info({ walletId: wallet.walletId, userId }, '[walletConsumers] Wallet created for agent');
    } else {
      logger.info({ walletId: wallet.walletId, userId }, '[walletConsumers] Wallet already exists for agent');
    }

    try {
      await publishEvent(Topics.WALLET_CREATED, {
        walletId: wallet.walletId,
        ownerId: wallet.ownerId,
        type: wallet.type,
        currency: wallet.currency
      });
    } catch (eventErr) {
      logger.error({ err: eventErr, userId }, '[walletConsumers] Failed to publish WALLET_CREATED event');
    }
  } catch (err) {
    logger.error({ err, userId }, '[walletConsumers] Failed to create wallet for agent');
  }
}

// Handle tournament.match_completed events. When a final winner is indicated,
// credit the wallet directly.
async function handleTournamentMatchCompleted(_topic, payload) {
  const { tournamentId, seasonId, winnerId, winnerPrize, winnerWalletId, isFinal } = payload;

  if (!isFinal) {
    return; // Only final winner should receive prize.
  }

  if (!winnerWalletId && !winnerId) {
    logger.warn({ payload }, '[walletConsumers] MATCH_COMPLETED final event missing winner identification');
    return;
  }

  if (!winnerPrize) {
    logger.warn({ payload }, '[walletConsumers] MATCH_COMPLETED final event missing winnerPrize');
    return;
  }

  try {
    let walletId = winnerWalletId;
    
    // If walletId not provided, find it by winnerId (ownerId)
    if (!walletId && winnerId) {
      const wallet = await prisma.wallet.findFirst({
        where: { ownerId: winnerId, type: 'player' }
      });
      if (!wallet) {
        logger.error({ winnerId }, '[walletConsumers] Winner wallet not found');
        return;
      }
      walletId = wallet.walletId;
    }

    // Credit the winner's wallet
    await prisma.wallet.update({
      where: { walletId },
      data: {
        balance: {
          increment: parseFloat(winnerPrize)
        },
        revenueBalance: {
          increment: parseFloat(winnerPrize)
        }
      }
    });

    logger.info({ walletId, tournamentId, seasonId, winnerId, amount: winnerPrize }, '[walletConsumers] Prize credited to winner');

    // Publish prize credited event
    try {
      await publishEvent(Topics.PRIZE_CREDITED, {
        tournamentId,
        seasonId,
        winnerId,
        walletId,
        amount: String(winnerPrize),
        currency: 'TZS'
      });
    } catch (eventErr) {
      logger.error({ err: eventErr, winnerId }, '[walletConsumers] Failed to publish PRIZE_CREDITED event');
    }

    // Send notification to winner
    try {
      await publishEvent(Topics.NOTIFICATION_SEND, {
        userId: winnerId,
        channel: 'in-app',
        type: 'prize_won',
        title: 'Tournament Prize Won!',
        message: `Congratulations! You won ${winnerPrize} TZS in the tournament`
      });
    } catch (notifErr) {
      logger.error({ err: notifErr, winnerId }, '[walletConsumers] Failed to send prize notification');
    }
  } catch (err) {
    logger.error({ err, tournamentId, winnerId }, '[walletConsumers] Failed to credit prize to winner');
  }
}

async function startWalletConsumers() {
  const topics = [
    Topics.PLAYER_REGISTERED,
    Topics.AGENT_REGISTERED,
    Topics.MATCH_COMPLETED,
    Topics.DEPOSIT_APPROVED,
    Topics.WITHDRAWAL_APPROVED
  ];

  let attempt = 0;
  // Keep retrying to connect to Kafka so wallet credits happen even if Kafka starts late.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await subscribeEvents('wallet-service', topics, async (topic, payload) => {
        const startTime = Date.now();
        try {
          if (topic === Topics.PLAYER_REGISTERED) {
            await handlePlayerRegistered(topic, payload);
          }
          if (topic === Topics.AGENT_REGISTERED) {
            await handleAgentRegistered(topic, payload);
          }
          if (topic === Topics.MATCH_COMPLETED) {
            await handleTournamentMatchCompleted(topic, payload);
          }
          if (topic === Topics.DEPOSIT_APPROVED) {
            await handleDepositApproved(topic, payload);
          }
          if (topic === Topics.WITHDRAWAL_APPROVED) {
            await handleWithdrawalApproved(topic, payload);
          }
          logProcessingResult(topic, startTime);
        } catch (err) {
          logProcessingResult(topic, startTime, err);
        }
      });
      return;
    } catch (err) {
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
      logger.error({ err, attempt, delay }, '[walletConsumers] Failed to subscribe to Kafka, retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = {
  startWalletConsumers
};
