// backend/services/game-service/src/controllers/authoritativeSocketController.js
/**
 * AUTHORITATIVE WEBSOCKET CONTROLLER
 * Real-time game execution over WebSocket
 * Integrates with ServerGameManager for secure gameplay
 */

const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const ServerGameManager = require('../engine/8ball/server-game-manager');
const { publishEvent, Topics } = require('../../../../shared/events');

// In-memory storage (production: use Redis)
const activeGames = new Map(); // matchId -> ServerGameManager
const socketToMatch = new Map(); // socketId -> matchId
const matchSockets = new Map(); // matchId -> Set<socketId>

const AI_PLAYER_ID = process.env.AI_PLAYER_ID || '04a942ce-af5f-4bde-9068-b9e2ee295fbf';

/**
 * Initialize WebSocket handlers
 */
function initializeAuthoritativeSocket(io) {
  
  io.on('connection', (socket) => {
    logger.info(`[AuthSocket] Client connected: ${socket.id}`);

    /**
     * Join a game match
     */
    socket.on('auth:join-match', async (data, callback) => {
      try {
        const { matchId, playerId } = data;

        if (!matchId || !playerId) {
          return callback({ success: false, error: 'matchId and playerId required' });
        }

        // Get match from database
        const match = await prisma.match.findUnique({
          where: { id: matchId }
        });

        if (!match) {
          return callback({ success: false, error: 'Match not found' });
        }

        // Verify player is in match
        if (match.player1Id !== playerId && match.player2Id !== playerId) {
          return callback({ success: false, error: 'Player not in match' });
        }

        // Join socket room
        socket.join(matchId);
        
        // Track socket
        socketToMatch.set(socket.id, matchId);
        if (!matchSockets.has(matchId)) {
          matchSockets.set(matchId, new Set());
        }
        matchSockets.get(matchId).add(socket.id);

        // Initialize game if not exists
        let game = activeGames.get(matchId);
        if (!game) {
          const isAiGame = match.player2Id === AI_PLAYER_ID;
          
          game = new ServerGameManager({
            matchId,
            gameType: isAiGame ? 'with_ai' : 'multiplayer',
            aiDifficulty: match.metadata?.aiDifficulty || 3
          });

          activeGames.set(matchId, game);

          logger.info(`[AuthSocket] Initialized game for match ${matchId}`, {
            gameType: isAiGame ? 'with_ai' : 'multiplayer'
          });
        }

        // Send current game state
        const gameState = game.getGameState();

        callback({
          success: true,
          data: {
            matchId,
            gameState,
            playerSide: match.player1Id === playerId ? 'p1' : 'p2'
          }
        });

        logger.info(`[AuthSocket] Player ${playerId} joined match ${matchId}`);

      } catch (error) {
        logger.error('[AuthSocket] Error joining match', { error, data });
        callback({ success: false, error: 'Failed to join match' });
      }
    });

    /**
     * Execute shot
     */
    socket.on('auth:execute-shot', async (data, callback) => {
      try {
        const { matchId, playerId, shot } = data;

        if (!matchId || !playerId || !shot) {
          return callback({ success: false, error: 'Invalid request data' });
        }

        // Get game
        const game = activeGames.get(matchId);
        if (!game) {
          return callback({ success: false, error: 'Game not found' });
        }

        // Get match
        const match = await prisma.match.findUnique({
          where: { id: matchId }
        });

        if (!match) {
          return callback({ success: false, error: 'Match not found' });
        }

        // Determine player side
        let playerSide;
        if (match.player1Id === playerId) {
          playerSide = 'p1';
        } else if (match.player2Id === playerId) {
          playerSide = 'p2';
        } else {
          return callback({ success: false, error: 'Player not in match' });
        }

        // Validate shot data
        if (!shot.direction || typeof shot.power !== 'number') {
          return callback({ success: false, error: 'Invalid shot data' });
        }

        // Execute shot
        const result = await game.executeShot(shot, playerSide);

        if (!result.success) {
          return callback(result);
        }

        // Save to database
        try {
          await saveShot(matchId, playerSide, shot, result.result);
        } catch (dbError) {
          logger.error('[AuthSocket] Failed to save shot', { dbError, matchId });
        }

        // Broadcast result to all players in match
        io.to(matchId).emit('auth:shot-result', {
          matchId,
          playerId: playerSide,
          result: result.result
        });

        // Send response to shooter
        callback({
          success: true,
          data: result.result
        });

        // If AI should play next, schedule AI turn
        if (result.result.aiWillPlayNext && !result.result.gameOver) {
          scheduleAiTurn(io, matchId, game, result.result.aiThinkTime || 1000);
        }

        // Handle game end
        if (result.result.gameOver) {
          await handleGameEnd(io, matchId, game, match);
        }

      } catch (error) {
        logger.error('[AuthSocket] Error executing shot', { error, data });
        callback({ success: false, error: 'Failed to execute shot' });
      }
    });

    /**
     * Request game state
     */
    socket.on('auth:get-state', async (data, callback) => {
      try {
        const { matchId } = data;

        const game = activeGames.get(matchId);
        if (!game) {
          return callback({ success: false, error: 'Game not found' });
        }

        const state = game.getGameState();

        callback({
          success: true,
          data: state
        });

      } catch (error) {
        logger.error('[AuthSocket] Error getting state', { error, data });
        callback({ success: false, error: 'Failed to get state' });
      }
    });

    /**
     * Leave match
     */
    socket.on('auth:leave-match', async (data) => {
      try {
        const { matchId } = data;
        
        socket.leave(matchId);
        
        if (matchSockets.has(matchId)) {
          matchSockets.get(matchId).delete(socket.id);
        }
        socketToMatch.delete(socket.id);

        logger.info(`[AuthSocket] Socket ${socket.id} left match ${matchId}`);

      } catch (error) {
        logger.error('[AuthSocket] Error leaving match', { error, data });
      }
    });

    /**
     * Disconnect handler
     */
    socket.on('disconnect', () => {
      try {
        const matchId = socketToMatch.get(socket.id);
        
        if (matchId && matchSockets.has(matchId)) {
          matchSockets.get(matchId).delete(socket.id);
          
          // If no more sockets in match, clean up after delay
          if (matchSockets.get(matchId).size === 0) {
            setTimeout(() => {
              if (matchSockets.has(matchId) && matchSockets.get(matchId).size === 0) {
                matchSockets.delete(matchId);
                
                // Keep game for a bit longer in case of reconnect
                setTimeout(() => {
                  if (activeGames.has(matchId)) {
                    const game = activeGames.get(matchId);
                    if (!game.getGameState().gameOver) {
                      logger.info(`[AuthSocket] Cleaning up inactive game ${matchId}`);
                    }
                    activeGames.delete(matchId);
                  }
                }, 5 * 60 * 1000); // 5 minutes
              }
            }, 30000); // 30 seconds
          }
        }

        socketToMatch.delete(socket.id);
        logger.info(`[AuthSocket] Client disconnected: ${socket.id}`);

      } catch (error) {
        logger.error('[AuthSocket] Error handling disconnect', { error, socketId: socket.id });
      }
    });
  });

  logger.info('[AuthSocket] Authoritative WebSocket handlers initialized');
}

/**
 * Schedule AI turn execution
 */
function scheduleAiTurn(io, matchId, game, thinkTime) {
  setTimeout(async () => {
    try {
      logger.info(`[AuthSocket] Executing AI turn for match ${matchId}`);

      const result = await game.executeAiTurn();

      if (!result.success) {
        logger.error('[AuthSocket] AI turn failed', { matchId, error: result.error });
        return;
      }

      // Save AI shot
      try {
        await saveShot(matchId, 'ai', {
          direction: { x: 0, y: 0 }, // AI calculates this internally
          power: 0
        }, result.result);
      } catch (dbError) {
        logger.error('[AuthSocket] Failed to save AI shot', { dbError, matchId });
      }

      // Broadcast AI result
      io.to(matchId).emit('auth:shot-result', {
        matchId,
        playerId: 'ai',
        result: result.result
      });

      // Check if game ended
      if (result.result.gameOver) {
        const match = await prisma.match.findUnique({
          where: { id: matchId }
        });
        if (match) {
          await handleGameEnd(io, matchId, game, match);
        }
      }

    } catch (error) {
      logger.error('[AuthSocket] Error executing AI turn', { error, matchId });
    }
  }, thinkTime);
}

/**
 * Save shot to database
 */
async function saveShot(matchId, playerId, shot, result) {
  await prisma.gameShot.create({
    data: {
      matchId,
      shotNumber: result.shotNumber,
      playerId,
      directionX: shot.direction?.x || 0,
      directionY: shot.direction?.y || 0,
      power: shot.power || 0,
      cueBallX: shot.cueBallPosition?.x,
      cueBallY: shot.cueBallPosition?.y,
      screw: shot.screw,
      english: shot.english,
      resultState: result,
      pocketedBalls: result.pocketed,
      fouls: result.fouls,
      firstContact: result.firstContact,
      stateHash: result.stateHash,
      executionTime: result.executionTime,
      executedAt: new Date()
    }
  });
}

/**
 * Handle game end
 */
async function handleGameEnd(io, matchId, game, match) {
  try {
    const gameState = game.getGameState();
    const winner = gameState.winner;

    logger.info(`[AuthSocket] Game ended for match ${matchId}, winner: ${winner}`);

    // Determine winner player ID
    let winnerPlayerId = null;
    if (winner === 'p1') {
      winnerPlayerId = match.player1Id;
    } else if (winner === 'p2') {
      winnerPlayerId = match.player2Id;
    }

    // Update match
    await prisma.match.update({
      where: { id: matchId },
      data: {
        status: 'completed',
        winnerId: winnerPlayerId,
        completedAt: new Date(),
        metadata: {
          ...match.metadata,
          gameResult: {
            winner,
            p1Score: gameState.p1Score,
            p2Score: gameState.p2Score,
            totalShots: gameState.shotNumber,
            stateHash: game.generateStateHash()
          }
        }
      }
    });

    // Broadcast game over
    io.to(matchId).emit('auth:game-over', {
      matchId,
      winner,
      winnerPlayerId,
      finalState: gameState
    });

    // Publish match completed event
    await publishEvent(Topics.MATCH_COMPLETED, {
      matchId,
      winnerId: winnerPlayerId,
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      betAmount: match.betAmount,
      gameType: match.gameType,
      timestamp: Date.now()
    });

    // Clean up after delay
    setTimeout(() => {
      activeGames.delete(matchId);
      matchSockets.delete(matchId);
      logger.info(`[AuthSocket] Cleaned up game ${matchId}`);
    }, 60000);

  } catch (error) {
    logger.error('[AuthSocket] Error handling game end', { error, matchId });
  }
}

module.exports = { initializeAuthoritativeSocket };
