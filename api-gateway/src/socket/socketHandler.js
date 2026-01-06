// backend/api-gateway/src/socket/socketHandler.js
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');

const connectedUsers = new Map();

const setupSocketIO = (io) => {
  // Authentication middleware for Socket.IO
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.userRole = decoded.role;
      socket.authToken = token;
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`User connected: ${socket.userId} (${socket.id})`);
    
    // Store connected user
    connectedUsers.set(socket.userId, socket.id);

    // Join user to their personal room
    socket.join(`user:${socket.userId}`);

    // Handle tournament room joins
    socket.on('join:tournament', (tournamentId) => {
      socket.join(`tournament:${tournamentId}`);
      logger.info(`User ${socket.userId} joined tournament ${tournamentId}`);
    });

    // Handle chat messages
    socket.on('chat:message', (data) => {
      socket.to(`match:${data.matchId}`).emit('chat:new-message', {
        userId: socket.userId,
        message: data.message,
        timestamp: new Date()
      });
    });

    // Handle admin dashboard stats broadcasts from services
    socket.on('broadcast:admin:dashboard:stats', (data) => {
      // Broadcast to all connected admins
      io.emit('admin:dashboard:stats', data);
    });

    socket.on('broadcast:admin:user:stats', (data) => {
      // Broadcast to all connected admins
      io.emit('admin:user:stats', data);
    });

    // Handle admin payment stats broadcasts from services
    socket.on('broadcast:admin:payment:stats', (data) => {
      // Broadcast to all connected admins
      io.emit('admin:payment:stats', data);
    });

    socket.on('broadcast:admin:deposit:update', (data) => {
      io.emit('admin:deposit:update', data);
    });

    socket.on('broadcast:admin:cashout:update', (data) => {
      io.emit('admin:cashout:update', data);
    });

    socket.on('broadcast:user:notification', (data) => {
      if (!data || !data.userId || !data.notification) return;
      io.to(`user:${data.userId}`).emit('notification:new', data.notification);
    });

    socket.on('broadcast:player:stats', (data) => {
      if (!data || !data.userId || !data.stats) return;
      io.to(`user:${data.userId}`).emit('player:stats', data.stats);
    });

    socket.on('player:stats:request', async (data) => {
      try {
        const requestedPlayerId = data?.playerId;
        if (requestedPlayerId && requestedPlayerId !== socket.userId) {
          socket.emit('player:stats:error', { message: 'Forbidden' });
          return;
        }

        const playerId = requestedPlayerId || socket.userId;
        const target = process.env.PLAYER_SERVICE_URL || 'http://localhost:3002';
        const response = await fetch(`${target}/api/players/${playerId}/stats`, {
          headers: {
            Authorization: `Bearer ${socket.authToken}`
          }
        });

        if (!response.ok) {
          const message = `Failed to fetch player stats (${response.status})`;
          socket.emit('player:stats:error', { message });
          return;
        }

        const payload = await response.json();
        const stats = payload?.data || payload;
        socket.emit('player:stats', stats);
      } catch (error) {
        logger.error('Failed to handle player:stats:request:', error);
        socket.emit('player:stats:error', { message: 'Failed to fetch player stats' });
      }
    });

    socket.on('player:tournaments:request', async () => {
      try {
        const target = process.env.TOURNAMENT_SERVICE_URL || 'http://localhost:3004';
        const response = await fetch(`${target}/tournament?limit=50&offset=0`, {
          headers: {
            Authorization: `Bearer ${socket.authToken}`
          }
        });

        if (!response.ok) {
          const message = `Failed to fetch tournaments (${response.status})`;
          socket.emit('player:tournaments:error', { message });
          return;
        }

        const payload = await response.json();
        const tournaments = payload?.data || payload;
        socket.emit('player:tournaments:update', tournaments);
      } catch (error) {
        logger.error('Failed to handle player:tournaments:request:', error);
        socket.emit('player:tournaments:error', { message: 'Failed to fetch tournaments' });
      }
    });

    socket.on('player:seasons:request', async (data) => {
      try {
        const tournamentId = data?.tournamentId;
        if (!tournamentId) {
          socket.emit('player:seasons:error', { message: 'Tournament ID is required' });
          return;
        }

        const target = process.env.TOURNAMENT_SERVICE_URL || 'http://localhost:3004';
        const response = await fetch(`${target}/tournament/${tournamentId}/seasons?limit=50&offset=0`, {
          headers: {
            Authorization: `Bearer ${socket.authToken}`
          }
        });

        if (!response.ok) {
          const message = `Failed to fetch seasons (${response.status})`;
          socket.emit('player:seasons:error', { message, tournamentId });
          return;
        }

        const payload = await response.json();
        const seasons = payload?.data || payload;
        socket.emit('player:seasons:update', { tournamentId, seasons });
      } catch (error) {
        logger.error('Failed to handle player:seasons:request:', error);
        socket.emit('player:seasons:error', { message: 'Failed to fetch seasons', tournamentId: data?.tournamentId });
      }
    });

    socket.on('admin:dashboard:request', async () => {
      try {
        const target = process.env.ADMIN_SERVICE_URL || 'http://localhost:3009';
        const response = await fetch(`${target}/dashboard`, {
          headers: {
            Authorization: `Bearer ${socket.authToken}`
          }
        });

        if (!response.ok) {
          const message = `Failed to fetch dashboard stats (${response.status})`;
          socket.emit('admin:dashboard:error', { message });
          return;
        }

        const payload = await response.json();
        const data = payload?.data || payload;
        socket.emit('admin:dashboard:stats', data);
      } catch (error) {
        logger.error('Failed to handle admin:dashboard:request:', error);
        socket.emit('admin:dashboard:error', { message: 'Failed to fetch dashboard stats' });
      }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
      logger.info(`User disconnected: ${socket.userId}`);
      connectedUsers.delete(socket.userId);
    });
  });

  logger.info('Socket.IO configured successfully');
};

// Emit to specific user
const emitToUser = (io, userId, event, data) => {
  io.to(`user:${userId}`).emit(event, data);
};

// Emit to tournament
const emitToTournament = (io, tournamentId, event, data) => {
  io.to(`tournament:${tournamentId}`).emit(event, data);
};

// Emit to match
const emitToMatch = (io, matchId, event, data) => {
  io.to(`match:${matchId}`).emit(event, data);
};

module.exports = {
  setupSocketIO,
  emitToUser,
  emitToTournament,
  emitToMatch
};
