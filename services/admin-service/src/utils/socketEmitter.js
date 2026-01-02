const { io } = require('socket.io-client');
const logger = require('./logger.js');

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
    logger.info('Admin service connected to API gateway via Socket.IO');
  });

  socket.on('disconnect', () => {
    logger.warn('Admin service disconnected from API gateway');
  });

  socket.on('connect_error', (error) => {
    logger.error('Admin service Socket.IO connection error:', error.message);
  });

  socket.on('error', (error) => {
    logger.error('Admin service Socket.IO error:', error);
  });

  return socket;
}

/**
 * Emit admin dashboard stats update
 */
async function emitDashboardStats(stats) {
  try {
    const sock = getSocket();
    if (sock && sock.connected) {
      sock.emit('broadcast:admin:dashboard:stats', {
        ...stats,
        timestamp: new Date()
      });
      logger.info('Emitted admin dashboard stats update');
    } else {
      logger.warn('Socket.IO not connected, skipping dashboard stats update');
    }
  } catch (error) {
    logger.error('Failed to emit dashboard stats update:', error);
  }
}

/**
 * Emit user stats update (when new user registers)
 */
async function emitUserStats(stats) {
  try {
    const sock = getSocket();
    if (sock && sock.connected) {
      sock.emit('broadcast:admin:user:stats', {
        ...stats,
        timestamp: new Date()
      });
      logger.info('Emitted admin user stats update');
    }
  } catch (error) {
    logger.error('Failed to emit user stats update:', error);
  }
}

/**
 * Emit payment stats update (when deposits/cashouts change)
 */
async function emitPaymentStats(stats) {
  try {
    const sock = getSocket();
    if (sock && sock.connected) {
      sock.emit('broadcast:admin:payment:stats', {
        ...stats,
        timestamp: new Date()
      });
      logger.info('Emitted admin payment stats update');
    }
  } catch (error) {
    logger.error('Failed to emit payment stats update:', error);
  }
}

module.exports = {
  getSocket,
  emitDashboardStats,
  emitUserStats,
  emitPaymentStats
};
