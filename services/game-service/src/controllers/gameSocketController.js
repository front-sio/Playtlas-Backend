const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../config/db.js');
const logger = require('../utils/logger.js');
const { publishEvent, Topics } = require('../../../../shared/events');

// Track connected players in game sessions
const gameSessionConnections = new Map(); // sessionId -> { player1Id: socketId, player2Id: socketId }
const playerToSession = new Map(); // playerId -> sessionId

exports.setupGameSocketHandlers = function(io) {
  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);
    
    let authenticatedPlayerId = null;
    let currentSessionId = null;

    // Authentication
    socket.on('authenticate', async ({ playerId, token }) => {
      try {
        // TODO: Verify JWT token properly with auth-service
        authenticatedPlayerId = playerId;
        
        // Check if player has an active session
        const activeSession = await prisma.gameSession.findFirst({
          where: {
            OR: [
              { player1Id: playerId },
              { player2Id: playerId }
            ],
            status: 'active'
          },
          orderBy: {
            createdAt: 'desc'
          }
        });

        socket.emit('authenticated', {
          success: true,
          playerId,
          hasActiveSession: !!activeSession,
          sessionId: activeSession?.sessionId
        });

        logger.info(`Player authenticated: ${playerId} (${socket.id})`);
      } catch (error) {
        logger.error({ err: error }, 'Authentication error');
        socket.emit('auth_error', { error: 'Authentication failed' });
      }
    });

    // Join game session
    socket.on('game:join', async ({ sessionId }) => {
      if (!authenticatedPlayerId) {
        return socket.emit('error', { message: 'Not authenticated' });
      }

      try {
        const session = await prisma.gameSession.findUnique({
          where: { sessionId }
        });

        if (!session) {
          return socket.emit('error', { message: 'Game session not found' });
        }

        const isPlayer1 = session.player1Id === authenticatedPlayerId;
        const isPlayer2 = session.player2Id === authenticatedPlayerId;

        if (!isPlayer1 && !isPlayer2) {
          return socket.emit('error', { message: 'Not authorized for this session' });
        }

        // Join socket room
        socket.join(`game:${sessionId}`);
        currentSessionId = sessionId;
        playerToSession.set(authenticatedPlayerId, sessionId);

        // Update session connections
        const connectionData = gameSessionConnections.get(sessionId) || {
          player1Id: null,
          player2Id: null,
          player1Connected: false,
          player2Connected: false
        };

        if (isPlayer1) {
          connectionData.player1Id = socket.id;
          connectionData.player1Connected = true;
        } else {
          connectionData.player2Id = socket.id;
          connectionData.player2Connected = true;
        }

        gameSessionConnections.set(sessionId, connectionData);

        // Notify opponent
        const opponentId = isPlayer1 ? session.player2Id : session.player1Id;
        socket.to(`game:${sessionId}`).emit('opponent:connected', {
          playerId: authenticatedPlayerId
        });

        // Send current game state
        const gameState = session.gameState ? JSON.parse(session.gameState) : null;
        
        socket.emit('game:joined', {
          sessionId,
          gameState,
          player1Id: session.player1Id,
          player2Id: session.player2Id,
          yourTurn: gameState?.currentPlayer === authenticatedPlayerId
        });

        // Check if both players are connected
        if (connectionData.player1Connected && connectionData.player2Connected) {
          io.to(`game:${sessionId}`).emit('game:ready', {
            message: 'Both players connected. Game starting!'
          });
        }

        logger.info(`Player ${authenticatedPlayerId} joined game session ${sessionId}`);
      } catch (error) {
        logger.error({ err: error }, 'Join game session error');
        socket.emit('error', { message: 'Failed to join game session' });
      }
    });

    // Player ready to play
    socket.on('game:ready', async () => {
      if (!authenticatedPlayerId || !currentSessionId) {
        return socket.emit('error', { message: 'Not in a game session' });
      }

      try {
        const session = await prisma.gameSession.findUnique({
          where: { sessionId: currentSessionId }
        });

        if (!session) return;

        const isPlayer1 = session.player1Id === authenticatedPlayerId;
        const isPlayer2 = session.player2Id === authenticatedPlayerId;

        // Update session
        const updateData = isPlayer1 
          ? { player1Ready: true }
          : { player2Ready: true };

        await prisma.gameSession.update({
          where: { sessionId: currentSessionId },
          data: updateData
        });

        // Get updated session
        const updatedSession = await prisma.gameSession.findUnique({
          where: { sessionId: currentSessionId }
        });

        // Notify opponent
        socket.to(`game:${currentSessionId}`).emit('opponent:ready', {
          playerId: authenticatedPlayerId
        });

        // Check if both ready
        if (updatedSession.player1Ready && updatedSession.player2Ready) {
          await prisma.gameSession.update({
            where: { sessionId: currentSessionId },
            data: { 
              status: 'active',
              startedAt: new Date()
            }
          });

          io.to(`game:${currentSessionId}`).emit('game:start', {
            message: 'Game started!',
            gameState: JSON.parse(updatedSession.gameState)
          });

          logger.info(`Game session ${currentSessionId} started`);
        }
      } catch (error) {
        logger.error({ err: error }, 'Player ready error');
      }
    });

    // Game actions (shots, moves, etc.)
    socket.on('game:action', async ({ action, data }) => {
      if (!authenticatedPlayerId || !currentSessionId) {
        return socket.emit('error', { message: 'Not in a game session' });
      }

      try {
        const session = await prisma.gameSession.findUnique({
          where: { sessionId: currentSessionId }
        });

        if (!session) return;

        // Verify player is part of session
        if (session.player1Id !== authenticatedPlayerId && session.player2Id !== authenticatedPlayerId) {
          return socket.emit('error', { message: 'Not part of this session' });
        }

        // Verify it's player's turn
        const gameState = JSON.parse(session.gameState);
        if (gameState.currentPlayer !== authenticatedPlayerId && action === 'shot') {
          return socket.emit('error', { message: 'Not your turn' });
        }

        // Broadcast action to opponent
        socket.to(`game:${currentSessionId}`).emit('game:action', {
          playerId: authenticatedPlayerId,
          action,
          data,
          timestamp: new Date().toISOString()
        });

        // Update session activity
        await prisma.gameSession.update({
          where: { sessionId: currentSessionId },
          data: { lastActivityAt: new Date() }
        });

        logger.info(`Game action from ${authenticatedPlayerId} in session ${currentSessionId}: ${action}`);
      } catch (error) {
        logger.error({ err: error }, 'Game action error');
        socket.emit('error', { message: 'Failed to process action' });
      }
    });

    // Update game state (after shot, etc.)
    socket.on('game:update_state', async ({ gameState }) => {
      if (!authenticatedPlayerId || !currentSessionId) {
        return socket.emit('error', { message: 'Not in a game session' });
      }

      try {
        await prisma.gameSession.update({
          where: { sessionId: currentSessionId },
          data: {
            gameState: JSON.stringify(gameState),
            lastActivityAt: new Date()
          }
        });

        // Broadcast updated state to opponent
        socket.to(`game:${currentSessionId}`).emit('game:state_updated', {
          gameState,
          timestamp: new Date().toISOString()
        });

        logger.info(`Game state updated for session ${currentSessionId}`);
      } catch (error) {
        logger.error({ err: error }, 'Update game state error');
        socket.emit('error', { message: 'Failed to update game state' });
      }
    });

    // Game completed
    socket.on('game:complete', async ({ winnerId, player1Score, player2Score, metadata }) => {
      if (!authenticatedPlayerId || !currentSessionId) {
        return socket.emit('error', { message: 'Not in a game session' });
      }

      try {
        const session = await prisma.gameSession.findUnique({
          where: { sessionId: currentSessionId }
        });

        if (!session) return;

        // Update game session
        await prisma.gameSession.update({
          where: { sessionId: currentSessionId },
          data: {
            status: 'completed',
            result: JSON.stringify({ winnerId, player1Score, player2Score }),
            metadata: metadata || session.metadata || {},
            endedAt: new Date()
          }
        });

        // Notify both players
        io.to(`game:${currentSessionId}`).emit('game:completed', {
          winnerId,
          player1Score,
          player2Score,
          timestamp: new Date().toISOString()
        });

        let sessionMetadata = {};
        if (typeof session.metadata === 'string') {
          try {
            sessionMetadata = JSON.parse(session.metadata || '{}');
          } catch (parseErr) {
            logger.warn({ err: parseErr, sessionId: currentSessionId }, 'Failed to parse game session metadata');
            sessionMetadata = {};
          }
        } else if (session.metadata) {
          sessionMetadata = session.metadata;
        }
        const matchId = sessionMetadata.matchId || metadata?.matchId;
        if (matchId) {
          try {
            await publishEvent(Topics.MATCH_RESULT, {
              matchId,
              winnerId,
              player1Score,
              player2Score,
              tournamentId: sessionMetadata.tournamentId || null,
              seasonId: sessionMetadata.seasonId || null
            });
          } catch (matchErr) {
            logger.error({ err: matchErr, matchId }, 'Failed to publish match result event');
          }
        } else {
          logger.warn({ sessionId: currentSessionId }, 'Missing matchId in game session metadata');
        }

        logger.info(`Game session ${currentSessionId} completed. Winner: ${winnerId}`);
      } catch (error) {
        logger.error({ err: error }, 'Game complete error');
        socket.emit('error', { message: 'Failed to complete game' });
      }
    });

    // Player disconnected
    socket.on('disconnect', async () => {
      logger.info(`Socket disconnected: ${socket.id}`);

      if (authenticatedPlayerId && currentSessionId) {
        // Notify opponent
        socket.to(`game:${currentSessionId}`).emit('opponent:disconnected', {
          playerId: authenticatedPlayerId
        });

        // Update connection status
        const connectionData = gameSessionConnections.get(currentSessionId);
        if (connectionData) {
          if (connectionData.player1Id === socket.id) {
            connectionData.player1Connected = false;
          } else if (connectionData.player2Id === socket.id) {
            connectionData.player2Connected = false;
          }
          gameSessionConnections.set(currentSessionId, connectionData);
        }

        // Remove player mapping
        playerToSession.delete(authenticatedPlayerId);

        // Check if player was player1 or player2 and update session
        try {
          const session = await prisma.gameSession.findUnique({
            where: { sessionId: currentSessionId }
          });

          if (session) {
            const updateData = {};
            if (session.player1Id === authenticatedPlayerId) {
              updateData.player1Connected = false;
            } else if (session.player2Id === authenticatedPlayerId) {
              updateData.player2Connected = false;
            }

            if (Object.keys(updateData).length > 0) {
              await prisma.gameSession.update({
                where: { sessionId: currentSessionId },
                data: updateData
              });
            }
          }
        } catch (error) {
          logger.error({ err: error }, 'Disconnect cleanup error');
        }
      }
    });
  });
};
