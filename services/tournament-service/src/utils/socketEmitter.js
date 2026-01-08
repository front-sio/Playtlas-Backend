const { io } = require('socket.io-client');
const logger = require('./logger');

let socket = null;

function getSocket() {
  if (socket) {
    return socket;
  }

  const API_GATEWAY_URL = process.env.API_GATEWAY_URL || 'http://localhost:8080';
  const API_GATEWAY_SOCKET_PATH = process.env.API_GATEWAY_SOCKET_PATH || '/socket.io/gateway';
  const socketToken = process.env.API_GATEWAY_SOCKET_TOKEN || process.env.SERVICE_SOCKET_TOKEN;

  if (!socketToken) {
    logger.warn('[tournament] Socket token missing; set API_GATEWAY_SOCKET_TOKEN to emit realtime updates');
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
    logger.info('[tournament] Connected to API gateway Socket.IO');
  });

  socket.on('disconnect', () => {
    logger.warn('[tournament] Disconnected from API gateway Socket.IO');
  });

  socket.on('connect_error', (error) => {
    logger.error('[tournament] Socket.IO connection error:', error.message);
  });

  socket.on('error', (error) => {
    logger.error('[tournament] Socket.IO error:', error);
  });

  return socket;
}

async function emitSeasonUpdate({ tournamentId, seasonId, event = 'season_updated' }) {
  if (!tournamentId) return;
  try {
    const sock = getSocket();
    if (sock && sock.connected) {
      sock.emit('broadcast:tournament:seasons:update', {
        tournamentId,
        seasonId: seasonId || null,
        event,
        timestamp: new Date().toISOString()
      });
    } else {
      logger.warn('[tournament] Socket.IO not connected, skipping season update emit');
    }
  } catch (error) {
    logger.error('[tournament] Failed to emit season update:', error);
  }
}

module.exports = {
  getSocket,
  emitSeasonUpdate
};
