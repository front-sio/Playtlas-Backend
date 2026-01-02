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

    // Handle match room joins
    socket.on('join:match', (matchId) => {
      socket.join(`match:${matchId}`);
      logger.info(`User ${socket.userId} joined match ${matchId}`);
    });

    // Handle game state updates
    socket.on('game:update', (data) => {
      socket.to(`match:${data.matchId}`).emit('game:state', data);
    });

    // Handle player moves
    socket.on('game:move', (data) => {
      socket.to(`match:${data.matchId}`).emit('game:opponent-move', data);
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
