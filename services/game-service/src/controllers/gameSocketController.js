const { prisma } = require('../config/db.js');
const logger = require('../utils/logger.js');
const { publishEvent, Topics } = require('../../../../shared/events');
const { EightBallEngine } = require('../engine/8ball');

const INSTANCE_ID = process.env.INSTANCE_ID || process.env.HOSTNAME || 'unknown';

// Track connected players in game sessions
const gameSessionConnections = new Map(); // sessionId -> { player1Id: socketId, player2Id: socketId }
const playerToSession = new Map(); // playerId -> sessionId
const sessionEngines = new Map(); // sessionId -> EightBallEngine
const sessionBroadcastTokens = new Map(); // sessionId -> number
const CLIENT_TABLE = { width: 1600, height: 900 };
const BROADCAST_FPS = Number(process.env.GAME_STATE_FPS || 30);
const CAPTURE_STRIDE = Number(process.env.GAME_STATE_STRIDE || 6);
const MAX_FRAMES = Number(process.env.GAME_STATE_MAX_FRAMES || 90);

function getServerTable(engine) {
  const scale = engine?.config?.adjustmentScale || 2.3;
  const n = 600 * scale;
  return {
    width: 100 * n,
    height: 50 * n,
  };
}

function mapClientToServer(engine, point) {
  if (!point) return null;
  const serverTable = getServerTable(engine);
  return {
    x: (point.x / CLIENT_TABLE.width) * serverTable.width - serverTable.width / 2,
    y: (point.y / CLIENT_TABLE.height) * serverTable.height - serverTable.height / 2,
  };
}

function mapServerToClient(engine, point) {
  if (!point) return null;
  const serverTable = getServerTable(engine);
  return {
    x: ((point.x + serverTable.width / 2) / serverTable.width) * CLIENT_TABLE.width,
    y: ((point.y + serverTable.height / 2) / serverTable.height) * CLIENT_TABLE.height,
  };
}

function mapDirectionToServer(engine, direction) {
  if (!direction) return null;
  const serverTable = getServerTable(engine);
  return {
    x: direction.x * (serverTable.width / CLIENT_TABLE.width),
    y: direction.y * (serverTable.height / CLIENT_TABLE.height),
  };
}

function mapVelocityToClient(engine, velocity) {
  if (!velocity) return null;
  const serverTable = getServerTable(engine);
  return {
    x: velocity.x * (CLIENT_TABLE.width / serverTable.width),
    y: velocity.y * (CLIENT_TABLE.height / serverTable.height),
  };
}

async function completeGameSession({ io, sessionId, winnerKey, winnerId: explicitWinnerId, rulesState, metadata }) {
  const session = await prisma.gameSession.findUnique({
    where: { sessionId }
  });

  if (!session) return;

  const winnerId = explicitWinnerId || (winnerKey === 'p1' ? session.player1Id : session.player2Id);
  const player1Score = Number(rulesState?.p1Score || 0);
  const player2Score = Number(rulesState?.p2Score || 0);

  await prisma.gameSession.update({
    where: { sessionId },
    data: {
      status: 'completed',
      result: JSON.stringify({ winnerId, player1Score, player2Score }),
      metadata: metadata || session.metadata || {},
      endedAt: new Date()
    }
  });

  io.to(`game:${sessionId}`).emit('game:completed', {
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
      logger.warn({ err: parseErr, sessionId }, 'Failed to parse game session metadata');
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
    logger.warn({ sessionId }, 'Missing matchId in game session metadata');
  }

  logger.info(`Game session ${sessionId} completed. Winner: ${winnerId}`);
}

function buildClientStateFromSnapshot(session, engine, snapshot) {
  const engineState = snapshot.state;
  const rulesState = engineState.rulesState || {};
  const currentPlayerId = rulesState.turn === 'p1' ? session.player1Id : session.player2Id;
  const balls = engineState.balls
    .filter(Boolean)
    .map((ball) => ({
      id: ball.id,
      pos: mapServerToClient(engine, { x: ball.position.x, y: ball.position.y }),
      vel: mapVelocityToClient(engine, { x: ball.velocity.x, y: ball.velocity.y }),
      active: ball.active === 1,
    }));

  const clientState = {
    balls,
    turn: rulesState.turn || 'p1',
    p1Target: rulesState.p1Target || 'ANY',
    p2Target: rulesState.p2Target || 'ANY',
    ballInHand: rulesState.ballInHand || engineState.cueBallInHand,
    winner: rulesState.winner || engineState.winner,
    foul: rulesState.foul || false,
    shotNumber: rulesState.shotNumber || 0,
    p1Score: rulesState.p1Score || 0,
    p2Score: rulesState.p2Score || 0,
    message: rulesState.message || '',
  };

  return {
    engineSnapshot: snapshot,
    clientState,
    rulesState,
    currentPlayer: currentPlayerId,
    turn: rulesState.turn,
    cueBallInHand: engineState.cueBallInHand,
    winner: engineState.winner,
    player1Id: session.player1Id,
    player2Id: session.player2Id,
  };
}

function buildClientState(session, engine) {
  return buildClientStateFromSnapshot(session, engine, engine.getSnapshot());
}

function broadcastFrames({ io, session, engine, frames }) {
  if (!frames || frames.length === 0) return;
  const token = Date.now();
  sessionBroadcastTokens.set(session.sessionId, token);
  const intervalMs = 1000 / Math.max(1, BROADCAST_FPS);

  frames.forEach((frame, idx) => {
    setTimeout(() => {
      if (sessionBroadcastTokens.get(session.sessionId) !== token) return;
      const payload = buildClientStateFromSnapshot(session, engine, frame);
      io.to(`game:${session.sessionId}`).emit('game:state_updated', {
        gameState: payload,
        tick: idx + 1,
        totalTicks: frames.length,
        timestamp: new Date().toISOString()
      });
    }, idx * intervalMs);
  });
}

async function getOrCreateEngine(session) {
  const existing = sessionEngines.get(session.sessionId);
  if (existing) return existing;

  const engine = new EightBallEngine();
  if (session.gameState) {
    try {
      const parsed = JSON.parse(session.gameState);
      engine.loadState(parsed?.engineSnapshot || parsed);
    } catch (error) {
      logger.warn({ err: error, sessionId: session.sessionId }, 'Failed to parse gameState for engine');
    }
  }
  sessionEngines.set(session.sessionId, engine);
  return engine;
}

exports.setupGameSocketHandlers = function(io) {
  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (instance ${INSTANCE_ID})`);
    
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
    socket.on('game:join', async ({ sessionId }, ack) => {
      if (!authenticatedPlayerId) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Not authenticated' });
        }
        return socket.emit('error', { message: 'Not authenticated' });
      }

      try {
        const session = await prisma.gameSession.findUnique({
          where: { sessionId }
        });

        if (!session) {
          if (typeof ack === 'function') {
            ack({ ok: false, error: 'Game session not found' });
          }
          return socket.emit('error', { message: 'Game session not found' });
        }

        const isPlayer1 = session.player1Id === authenticatedPlayerId;
        const isPlayer2 = session.player2Id === authenticatedPlayerId;

        if (!isPlayer1 && !isPlayer2) {
          if (typeof ack === 'function') {
            ack({ ok: false, error: 'Not authorized for this session' });
          }
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
        if (typeof ack === 'function') {
          ack({ ok: true, sessionId });
        }
        logger.info({
          sessionId,
          playerId: authenticatedPlayerId,
          socketId: socket.id,
          rooms: Array.from(socket.rooms)
        }, 'Player joined game session');

        // Notify opponent
        const opponentId = isPlayer1 ? session.player2Id : session.player1Id;
        socket.to(`game:${sessionId}`).emit('opponent:connected', {
          playerId: authenticatedPlayerId
        });

        const engine = await getOrCreateEngine(session);
        const gameState = buildClientState(session, engine);
        await prisma.gameSession.update({
          where: { sessionId },
          data: {
            gameState: JSON.stringify(gameState),
            lastActivityAt: new Date()
          }
        });
        
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
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Failed to join game session' });
        }
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

        const readyCount = Number(updatedSession.player1Ready) + Number(updatedSession.player2Ready);
        io.to(`game:${currentSessionId}`).emit('game:ready_update', {
          readyCount,
          totalPlayers: 2
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

          const engine = await getOrCreateEngine(updatedSession);
          const parsedState = buildClientState(updatedSession, engine);

          io.to(`game:${currentSessionId}`).emit('game:start', {
            message: 'Game started!',
            gameState: parsedState
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
        const engine = await getOrCreateEngine(session);
        const clientState = buildClientState(session, engine);
        if (clientState.currentPlayer !== authenticatedPlayerId && action === 'shot') {
          return socket.emit('error', { message: 'Not your turn' });
        }

        if (action === 'shot') {
          if (
            !data?.direction ||
            typeof data.direction.x !== 'number' ||
            typeof data.direction.y !== 'number' ||
            typeof data?.power !== 'number'
          ) {
            return socket.emit('error', { message: 'Invalid shot payload' });
          }
          const direction = mapDirectionToServer(engine, data.direction);
          const cueBallPosition = mapClientToServer(engine, data.cueBallPosition);
          const shotResult = engine.applyShot(clientState.turn, {
            direction,
            power: data.power,
            cueBallPosition,
            screw: data.screw,
            english: data.english
          }, {
            capture: {
              stride: CAPTURE_STRIDE,
              maxFrames: MAX_FRAMES
            }
          });

          if (!shotResult.ok) {
            return socket.emit('error', { message: shotResult.error || 'Shot rejected' });
          }

          const updatedState = buildClientState(session, engine);
          await prisma.gameSession.update({
            where: { sessionId: currentSessionId },
            data: {
              gameState: JSON.stringify(updatedState),
              lastActivityAt: new Date()
            }
          });

          if (shotResult.frames && shotResult.frames.length > 0) {
            broadcastFrames({ io, session, engine, frames: shotResult.frames });
          } else {
            io.to(`game:${currentSessionId}`).emit('game:state_updated', {
              gameState: updatedState,
              shotResult: shotResult.shotResult,
              timestamp: new Date().toISOString()
            });
          }

          if (updatedState?.winner) {
            await completeGameSession({
              io,
              sessionId: currentSessionId,
              winnerKey: updatedState.winner,
              rulesState: updatedState.rulesState,
              metadata: updatedState.rulesState || {}
            });
          }
        } else {
          socket.to(`game:${currentSessionId}`).emit('game:action', {
            playerId: authenticatedPlayerId,
            action,
            data,
            timestamp: new Date().toISOString()
          });
        }

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
    socket.on('game:update_state', async () => {
      socket.emit('error', { message: 'Client state updates are disabled for authoritative sessions' });
    });

    // Game completed
    socket.on('game:complete', async ({ winnerId, player1Score, player2Score, metadata }) => {
      if (!authenticatedPlayerId || !currentSessionId) {
        return socket.emit('error', { message: 'Not in a game session' });
      }

      try {
        if (!winnerId) {
          return socket.emit('error', { message: 'Winner required' });
        }
        await completeGameSession({
          io,
          sessionId: currentSessionId,
          winnerId,
          rulesState: { p1Score: player1Score, p2Score: player2Score },
          metadata
        });
      } catch (error) {
        logger.error({ err: error }, 'Game complete error');
        socket.emit('error', { message: 'Failed to complete game' });
      }
    });

    // Player disconnected
    socket.on('disconnect', async (reason) => {
      logger.info(`Socket disconnected: ${socket.id} (${reason})`);

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
