const { io } = require('socket.io-client');
const logger = require('./logger');

let socket = null;

function getSocket() {
  if (socket) {
    return socket;
  }

  const API_GATEWAY_URL = process.env.API_GATEWAY_URL || 'http://localhost:8080';
  const API_GATEWAY_SOCKET_PATH = process.env.API_GATEWAY_SOCKET_PATH || '/socket.io';
  const socketToken = process.env.API_GATEWAY_SOCKET_TOKEN || process.env.SERVICE_SOCKET_TOKEN;

  if (!socketToken) {
    logger.warn('Socket.IO token missing; set API_GATEWAY_SOCKET_TOKEN to enable real-time notifications');
    return null;
  }

  socket = io(API_GATEWAY_URL, {
    path: API_GATEWAY_SOCKET_PATH,
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket', 'polling'],
    auth: { token: socketToken }
  });

  socket.on('connect', () => {
    logger.info('Notification service connected to API gateway via Socket.IO');
  });

  socket.on('disconnect', () => {
    logger.warn('Notification service disconnected from API gateway');
  });

  socket.on('connect_error', (error) => {
    logger.error('Notification service Socket.IO connection error:', error.message);
  });

  socket.on('error', (error) => {
    logger.error('Notification service Socket.IO error:', error);
  });

  return socket;
}

async function emitUserNotification(userId, notification) {
  try {
    const sock = getSocket();
    if (sock && sock.connected) {
      sock.emit('broadcast:user:notification', {
        userId,
        notification
      });
    } else {
      logger.warn('Socket.IO not connected, skipping user notification emit');
    }
  } catch (error) {
    logger.error('Failed to emit user notification:', error);
  }
}

module.exports = {
  getSocket,
  emitUserNotification
};
