const { io } = require('socket.io-client');
const { logger } = require('./logger.js');

let socket = null;

function getSocket() {
  if (socket) {
    return socket;
  }

  const API_GATEWAY_URL = process.env.API_GATEWAY_URL || 'http://localhost:8080';
  
  socket = io(API_GATEWAY_URL, {
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket', 'polling']
  });

  socket.on('connect', () => {
    logger.info('Payment service connected to API gateway via Socket.IO');
  });

  socket.on('disconnect', () => {
    logger.warn('Payment service disconnected from API gateway');
  });

  socket.on('connect_error', (error) => {
    logger.error('Payment service Socket.IO connection error:', error.message);
  });

  socket.on('error', (error) => {
    logger.error('Payment service Socket.IO error:', error);
  });

  return socket;
}

/**
 * Emit admin payment stats update
 */
async function emitAdminStatsUpdate(pendingDeposits, pendingCashouts) {
  try {
    const sock = getSocket();
    if (sock && sock.connected) {
      sock.emit('broadcast:admin:payment:stats', {
        pendingDeposits,
        pendingCashouts,
        timestamp: new Date()
      });
      logger.info('Emitted admin payment stats update:', { pendingDeposits, pendingCashouts });
    } else {
      logger.warn('Socket.IO not connected, skipping admin stats update');
    }
  } catch (error) {
    logger.error('Failed to emit admin stats update:', error);
  }
}

/**
 * Emit deposit status update
 */
async function emitDepositUpdate(type, count) {
  try {
    const sock = getSocket();
    if (sock && sock.connected) {
      sock.emit('broadcast:admin:deposit:update', {
        type,
        count,
        timestamp: new Date()
      });
      logger.info('Emitted deposit update:', { type, count });
    }
  } catch (error) {
    logger.error('Failed to emit deposit update:', error);
  }
}

/**
 * Emit cashout status update
 */
async function emitCashoutUpdate(type, count) {
  try {
    const sock = getSocket();
    if (sock && sock.connected) {
      sock.emit('broadcast:admin:cashout:update', {
        type,
        count,
        timestamp: new Date()
      });
      logger.info('Emitted cashout update:', { type, count });
    }
  } catch (error) {
    logger.error('Failed to emit cashout update:', error);
  }
}

/**
 * Get current pending counts and emit
 */
async function emitCurrentPendingStats() {
  try {
    const { prisma } = require('../config/db.js');
    
    const pendingDeposits = await prisma.deposit.count({
      where: {
        status: 'pending_approval'
      }
    });

    const pendingCashouts = await prisma.withdrawal.count({
      where: {
        status: {
          in: ['pending', 'pending_approval']
        }
      }
    });

    await emitAdminStatsUpdate(pendingDeposits, pendingCashouts);
  } catch (error) {
    logger.error('Failed to emit current pending stats:', error);
  }
}

module.exports = {
  getSocket,
  emitAdminStatsUpdate,
  emitDepositUpdate,
  emitCashoutUpdate,
  emitCurrentPendingStats
};
