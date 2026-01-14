const { io } = require('socket.io-client');
const { logger } = require('./logger.js');

let socket = null;

function getSocket() {
  if (socket) {
    return socket;
  }

  const API_GATEWAY_URL = process.env.API_GATEWAY_URL || 'http://localhost:8080';
  const API_GATEWAY_SOCKET_PATH = process.env.API_GATEWAY_SOCKET_PATH || '/socket.io';
  
  socket = io(API_GATEWAY_URL, {
    path: API_GATEWAY_SOCKET_PATH,
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket', 'polling']
  });

  socket.on('connect', () => {
    logger.info('Agent service connected to API gateway via Socket.IO');
  });

  socket.on('disconnect', () => {
    logger.warn('Agent service disconnected from API gateway');
  });

  socket.on('connect_error', (error) => {
    logger.error('Agent service Socket.IO connection error:', error.message);
  });

  socket.on('error', (error) => {
    logger.error('Agent service Socket.IO error:', error);
  });

  return socket;
}

/**
 * Emit event when agent wallet is created
 */
async function emitAgentWalletCreated(data) {
  try {
    const sock = getSocket();
    if (sock && sock.connected) {
      sock.emit('broadcast:admin:user:stats', {
        ...data,
        timestamp: new Date()
      });
      logger.info('Emitted agent wallet created event');
    } else {
      logger.warn('Socket.IO not connected, skipping wallet created event');
    }
  } catch (error) {
    logger.error('Failed to emit agent wallet created event:', error);
  }
}

module.exports = {
  getSocket,
  emitAgentWalletCreated
};
