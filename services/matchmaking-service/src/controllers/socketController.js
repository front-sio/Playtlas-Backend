const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { prisma } = require('../config/db.js');

const connectedPlayers = new Map(); // playerId -> socketId
const pendingChallenges = new Map(); // challengeId -> { from, to }
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'http://localhost:3006';

exports.setupSocketHandlers = function(io) {
  io.on('connection', (socket) => {
    console.log(`[matchmaking] connected ${socket.id}`);
    socket.on('disconnect', (reason) => {
      console.warn(`[matchmaking] disconnected ${socket.id} (${reason}) player=${authenticatedPlayerId || 'unknown'}`);
    });
    socket.on('error', (err) => {
      console.error(`[matchmaking] socket error ${socket.id}`, err);
    });
    
    let authenticatedPlayerId = null;

    // Authentication
    socket.on('authenticate', async ({ playerId, token }) => {
      try {
        // TODO: Verify JWT token properly
        authenticatedPlayerId = playerId;
        connectedPlayers.set(playerId, socket.id);
        
        socket.join(`player:${playerId}`);
        
        socket.emit('authenticated', {
          success: true,
          playerId
        });
        
        console.log(`✓ Player authenticated: ${playerId} (${socket.id})`);
      } catch (error) {
        socket.emit('auth_error', { error: error.message });
      }
    });

    // Join match room
    socket.on('join:match', async (payload, maybeAck) => {
      // Support both payload shapes:
      // 1) socket.emit('join:match', matchId:string, ack:function)
      // 2) socket.emit('join:match', {matchId:string}, ack:function)
      const matchId = typeof payload === 'string' ? payload : payload?.matchId;
      const ack = typeof maybeAck === 'function' ? maybeAck : (typeof payload === 'function' ? payload : null);
      
      // Validate matchId early
      if (!matchId) {
        ack?.({ ok: false, error: 'matchId required' });
        return socket.emit('error', { message: 'matchId required' });
      }

      if (!authenticatedPlayerId) {
        ack?.({ ok: false, error: 'Not authenticated' });
        return socket.emit('error', { message: 'Not authenticated' });
      }

      try {
        const match = await prisma.match.findUnique({
          where: { matchId }
        });

        if (!match) {
          ack?.({ ok: false, error: 'Match not found' });
          return socket.emit('error', { message: 'Match not found' });
        }

        const isPlayer1 = match.player1Id === authenticatedPlayerId;
        const isPlayer2 = match.player2Id === authenticatedPlayerId;

        if (!isPlayer1 && !isPlayer2) {
          ack?.({ ok: false, error: 'Not part of this match' });
          return socket.emit('error', { message: 'Not part of this match' });
        }

        socket.join(`match:${matchId}`);
        ack?.({ ok: true, matchId });
        socket.emit('match:joined', { matchId });
        const readyCount = Number(match.player1Ready) + Number(match.player2Ready);
        socket.emit('match:ready_update', {
          matchId,
          readyCount,
          totalPlayers: 2
        });

        // Send timing info if match is in progress
        const now = new Date();
        if (match.startedAt) {
          const elapsedSeconds = Math.floor((now - new Date(match.startedAt)) / 1000);
          const remainingSeconds = Math.max(0, 300 - elapsedSeconds);
          
          socket.emit('match:timing_info', {
            matchId,
            startedAt: match.startedAt.toISOString(),
            elapsedSeconds,
            remainingSeconds,
            maxDurationSeconds: 300
          });
        }

        socket.emit('match:state', {
          matchId,
          status: match.status,
          readyCount,
          totalPlayers: 2,
          sessionId: match.gameSessionId || null,
          startedAt: match.startedAt?.toISOString() || null
        });
        
        if (match.gameSessionId) {
          socket.emit('game:session_created', {
            sessionId: match.gameSessionId,
            matchId,
            startedAt: match.startedAt?.toISOString() || null,
            maxDurationSeconds: 300
          });
        }
        
        // Notify others in the room
        socket.to(`match:${matchId}`).emit('opponent-joined', {
          playerId: authenticatedPlayerId,
          playerRole: isPlayer1 ? 'p1' : 'p2'
        });

        console.log(`✓ Player ${authenticatedPlayerId} joined match ${matchId} (${socket.id})`);
      } catch (error) {
        console.error('Join match error:', error);
        const message = error?.message || 'Failed to join match';
        ack?.({ ok: false, error: message });
        socket.emit('error', { message });
      }
    });

    // Join tournament or season rooms for realtime updates
    socket.on('join:season', ({ tournamentId, seasonId }) => {
      if (!authenticatedPlayerId) {
        return socket.emit('error', { message: 'Not authenticated' });
      }
      if (tournamentId) {
        socket.join(`tournament:${tournamentId}`);
      }
      if (seasonId) {
        socket.join(`season:${seasonId}`);
      }
      socket.emit('season:joined', { tournamentId, seasonId });
    });

    // Challenge a friend
    socket.on('challenge:send', ({ to: challengedPlayerId }) => {
      if (!authenticatedPlayerId) return;
      const challengerSocketId = socket.id;
      const challengedSocketId = connectedPlayers.get(challengedPlayerId);

      if (!challengedSocketId) {
        return socket.emit('challenge:error', { message: 'Player not online' });
      }

      const challengeId = uuidv4();
      pendingChallenges.set(challengeId, { from: authenticatedPlayerId, to: challengedPlayerId });

      io.to(challengedSocketId).emit('challenge:received', {
        challengeId,
        from: authenticatedPlayerId, // In a real app, send username from a user service
      });

      socket.emit('challenge:sent', { challengeId, to: challengedPlayerId });
    });

const { createP2PMatch } = require('./matchCreationController.js');

// ... (rest of the file)

    socket.on('challenge:accept', async ({ challengeId }) => {
      if (!authenticatedPlayerId) return;
      const challenge = pendingChallenges.get(challengeId);

      if (!challenge || challenge.to !== authenticatedPlayerId) {
        return;
      }

      const { from: challengerId, to: challengedId } = challenge;

      // Create match using the new generic function
      const matches = await createP2PMatch(challengerId, challengedId);
      if (!matches || matches.length === 0) {
        // Handle error: match not created
        return;
      }
      const match = matches[0];


      const challengerSocket = connectedPlayers.get(challengerId);
      const challengedSocket = connectedPlayers.get(challengedId);

      if (challengerSocket) {
        io.to(challengerSocket).emit('match:found', { matchId: match.matchId, opponentId: challengedId });
      }
      if (challengedSocket) {
        io.to(challengedSocket).emit('match:found', { matchId: match.matchId, opponentId: challengerId });
      }

      pendingChallenges.delete(challengeId);
    });
// ... (rest of the file)


    socket.on('challenge:decline', ({ challengeId }) => {
      if (!authenticatedPlayerId) return;
      const challenge = pendingChallenges.get(challengeId);

      if (!challenge || challenge.to !== authenticatedPlayerId) {
        return;
      }
      
      const challengerSocket = connectedPlayers.get(challenge.from);
      if (challengerSocket) {
        io.to(challengerSocket).emit('challenge:declined', { from: authenticatedPlayerId });
      }

      pendingChallenges.delete(challengeId);
    });

    // Join match queue
    socket.on('queue:join', async ({ tournamentId, seasonId, round }) => {
      if (!authenticatedPlayerId) {
        return socket.emit('error', { message: 'Not authenticated' });
      }

      try {
        // Check if already in queue
        if (!prisma.matchQueue) {
          return socket.emit('queue:error', { message: 'Match queue is not enabled' });
        }

        const existing = await prisma.matchQueue.findFirst({
          where: { playerId: authenticatedPlayerId }
        });

        if (existing) {
          return socket.emit('queue:error', { message: 'Already in queue' });
        }

        // Add to queue
        const queueEntry = {
          id: uuidv4(),
          playerId: authenticatedPlayerId,
          tournamentId,
          seasonId,
          round,
          playerRating: 1000, // Get from player service
          status: 'waiting'
        };

        await prisma.matchQueue.create({ data: queueEntry });

        socket.join(`queue:${tournamentId}:${round}`);
        
        socket.emit('queue:joined', {
          success: true,
          queueId: queueEntry.id,
          estimatedWaitTime: 60
        });

        // Try to find match
        findMatch(io, tournamentId, seasonId, round);
        
      } catch (error) {
        console.error('Queue join error:', error);
        socket.emit('queue:error', { message: error.message });
      }
    });

    // Leave queue
    socket.on('queue:leave', async () => {
      if (!authenticatedPlayerId) return;

      try {
        if (!prisma.matchQueue) return;
        await prisma.matchQueue.delete({
          where: { playerId: authenticatedPlayerId }
        });
        
        socket.emit('queue:left', { success: true });
      } catch (error) {
        console.error('Queue leave error:', error);
      }
    });

    // Player ready for match
    socket.on('match:ready', async ({ matchId }, ack) => {
      if (!authenticatedPlayerId) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Not authenticated' });
        }
        return;
      }

      try {
        const match = await prisma.match.findUnique({
          where: { matchId }
        });

        if (!match) {
          if (typeof ack === 'function') {
            ack({ ok: false, error: 'Match not found' });
          }
          return socket.emit('error', { message: 'Match not found' });
        }

        const isPlayer1 = match.player1Id === authenticatedPlayerId;
        const isPlayer2 = match.player2Id === authenticatedPlayerId;

        if (!isPlayer1 && !isPlayer2) {
          if (typeof ack === 'function') {
            ack({ ok: false, error: 'Not part of this match' });
          }
          return socket.emit('error', { message: 'Not part of this match' });
        }

        // Update ready status and connection time
        const now = new Date();
        const updateData = isPlayer1 
          ? { player1Ready: true, player1ConnectionTime: now }
          : { player2Ready: true, player2ConnectionTime: now };

        await prisma.match.update({
          where: { matchId },
          data: updateData
        });

        // Check if both ready to start the match timer
        const updatedMatch = await prisma.match.findUnique({
          where: { matchId }
        });
        
        if (typeof ack === 'function') {
          ack({ ok: true });
        }
        
        const readyCount = Number(updatedMatch.player1Ready) + Number(updatedMatch.player2Ready);
        io.to(`match:${matchId}`).emit('match:ready_update', {
          matchId,
          readyCount,
          totalPlayers: 2
        });

        // Start match when both players are ready
        if (updatedMatch.player1Ready && updatedMatch.player2Ready && !updatedMatch.startedAt) {
          const startTime = new Date();
          await prisma.match.update({
            where: { matchId },
            data: { 
              status: 'in-progress',
              startedAt: startTime
            }
          });

          // Notify players that match has started with timing info
          io.to(`match:${matchId}`).emit('match:started', {
            matchId,
            startedAt: startTime.toISOString(),
            maxDurationSeconds: 300, // 5 minutes
            gameSessionId: updatedMatch.gameSessionId
          });

          // Start game session if it exists
          if (updatedMatch.gameSessionId) {
            io.to(`match:${matchId}`).emit('game:session_created', {
              sessionId: updatedMatch.gameSessionId,
              matchId,
              startedAt: startTime.toISOString(),
              maxDurationSeconds: 300
            });
          }
        } else {
          // Send timing info for ongoing match
          if (updatedMatch.startedAt) {
            const elapsedSeconds = Math.floor((now - new Date(updatedMatch.startedAt)) / 1000);
            const remainingSeconds = Math.max(0, 300 - elapsedSeconds);
            
            socket.emit('match:timing_info', {
              matchId,
              startedAt: updatedMatch.startedAt.toISOString(),
              elapsedSeconds,
              remainingSeconds,
              maxDurationSeconds: 300
            });
          }

          // Notify waiting for opponent
          io.to(`match:${matchId}`).emit('match:waiting_opponent', {
            matchId,
            playersReady: readyCount
          });
        }

      } catch (error) {
        console.error('Match ready error:', error);
        socket.emit('error', { message: error.message });
      }
    });

    socket.on('match:sync', async ({ matchId }) => {
      if (!authenticatedPlayerId) {
        return socket.emit('error', { message: 'Not authenticated' });
      }

      try {
        const match = await prisma.match.findUnique({
          where: { matchId }
        });

        if (!match) {
          return socket.emit('error', { message: 'Match not found' });
        }

        const readyCount = Number(match.player1Ready) + Number(match.player2Ready);
        socket.emit('match:state', {
          matchId,
          status: match.status,
          readyCount,
          totalPlayers: 2,
          sessionId: match.gameSessionId || null,
          startedAt: match.startedAt?.toISOString() || null
        });

        // Send timing info if match is in progress
        if (match.startedAt) {
          const now = new Date();
          const elapsedSeconds = Math.floor((now - new Date(match.startedAt)) / 1000);
          const remainingSeconds = Math.max(0, 300 - elapsedSeconds);
          
          socket.emit('match:timing_info', {
            matchId,
            startedAt: match.startedAt.toISOString(),
            elapsedSeconds,
            remainingSeconds,
            maxDurationSeconds: 300
          });

          // Auto-complete match if time expired
          if (remainingSeconds <= 0 && match.status === 'in-progress') {
            await prisma.match.update({
              where: { matchId },
              data: {
                status: 'completed',
                completedAt: new Date(),
                winnerId: null, // Timeout - no winner
                metadata: {
                  ...match.metadata,
                  result: 'timeout'
                }
              }
            });

            io.to(`match:${matchId}`).emit('match:timeout', {
              matchId,
              completedAt: new Date().toISOString(),
              reason: 'time_expired'
            });
          }
        }
      } catch (error) {
        console.error('Match sync error:', error);
        socket.emit('error', { message: 'Failed to sync match state' });
      }
    });

    // Game session - join (handled by game-service)
    socket.on('game:join', async () => {
      socket.emit('error', { message: 'Game sessions are handled by game-service' });
    });

    // Game events
    socket.on('game:action', async () => {
      socket.emit('error', { message: 'Game sessions are handled by game-service' });
    });

    // Match completed
    socket.on('game:complete', async () => {
      socket.emit('error', { message: 'Game sessions are handled by game-service' });
    });

    // Disconnect
    socket.on('disconnect', async () => {
      console.log(`🔌 Player disconnected: ${socket.id}`);
      
      if (authenticatedPlayerId) {
        connectedPlayers.delete(authenticatedPlayerId);

        // Remove from queue if present
        try {
          if (prisma.matchQueue) {
            await prisma.matchQueue.deleteMany({
              where: { playerId: authenticatedPlayerId }
            });
          }
        } catch (error) {
          console.warn('[matchmaking] disconnect cleanup skipped', error);
        }
      }
    });
  });
}

// Helper: Find match from queue
async function findMatch(io, tournamentId, seasonId, round) {
  try {
    if (!prisma.matchQueue) return;
    const waiting = await prisma.matchQueue.findMany({
      where: {
        tournamentId,
        seasonId,
        round,
        status: 'waiting'
      },
      take: 2
    });

    if (waiting.length >= 2) {
      const [player1, player2] = waiting;

      // Create match
      const matchId = uuidv4();
      const scheduledTime = new Date(Date.now() + 5000); // 5 seconds from now

      await prisma.match.create({
        data: {
        matchId,
        tournamentId,
        seasonId,
        roundNumber: round,
        stage: 'queue',
        player1Id: player1.playerId,
        player2Id: player2.playerId,
        status: 'ready',
        scheduledTime
      }});

      // Update queue entries
      await prisma.matchQueue.updateMany({
        where: {
          id: { in: [player1.id, player2.id] }
        },
        data: { status: 'matched', matchedAt: new Date() }
      });

      // Notify players
      const player1Socket = connectedPlayers.get(player1.playerId);
      const player2Socket = connectedPlayers.get(player2.playerId);

      if (player1Socket) {
        io.to(player1Socket).emit('match:found', {
          matchId,
          opponentId: player2.playerId,
          scheduledTime,
          round
        });
      }

      if (player2Socket) {
        io.to(player2Socket).emit('match:found', {
          matchId,
          opponentId: player1.playerId,
          scheduledTime,
          round
        });
      }

      console.log(`✓ Match created: ${matchId}`);
    }
  } catch (error) {
    console.error('Find match error:', error);
  }
}

// Helper: Start game session (simplified since sessions are pre-created)
async function startGameSession(io, matchId) {
  try {
    const match = await prisma.match.findUnique({
      where: { matchId }
    });

    if (!match) return;
    if (['completed', 'cancelled'].includes(match.status)) {
      return;
    }

    // Game session should already exist from match creation
    if (match.gameSessionId) {
      let sessionExists = false;
      try {
        const existing = await axios.get(`${GAME_SERVICE_URL}/sessions/${match.gameSessionId}`);
        sessionExists = Boolean(existing?.data?.data?.sessionId || existing?.data?.data?.session?.sessionId);
      } catch (error) {
        console.warn('Start game session: existing session lookup failed', error?.response?.data?.error || error?.message);
      }

      if (sessionExists) {
        const startTime = match.startedAt || new Date();
        if (match.status !== 'in-progress') {
          await prisma.match.update({
            where: { matchId },
            data: {
              status: 'in-progress',
              startedAt: startTime
            }
          });
        }

        io.to(`match:${matchId}`).emit('game:session_created', {
          sessionId: match.gameSessionId,
          matchId,
          startedAt: startTime.toISOString(),
          maxDurationSeconds: 300
        });
        return;
      }
    }

    // Fallback: create session if it doesn't exist
    const response = await axios.post(`${GAME_SERVICE_URL}/sessions`, {
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      metadata: {
        matchId: match.matchId,
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        maxDurationSeconds: 300
      }
    });

    const sessionId = response?.data?.data?.sessionId || response?.data?.data?.session?.sessionId;
    if (!sessionId) {
      console.error('Start game session error: Missing sessionId from game-service');
      return;
    }

    const startTime = new Date();
    await prisma.match.update({
      where: { matchId },
      data: {
        gameSessionId: sessionId,
        status: 'in-progress',
        startedAt: startTime
      }
    });

    // Notify players
    io.to(`match:${matchId}`).emit('game:session_created', {
      sessionId,
      matchId,
      startedAt: startTime.toISOString(),
      maxDurationSeconds: 300
    });

    console.log(`✓ Game session created: ${sessionId}`);
  } catch (error) {
    const message = error?.response?.data?.error || error?.message || 'Failed to start game session';
    console.error('Start game session error:', message);
    io.to(`match:${matchId}`).emit('match:session_error', { matchId, message });
  }
}

// Helper: Initialize game state
function initializeGameState(session) {
  return {
    balls: initializeBalls(),
    currentPlayer: session.player1Id,
    scores: { [session.player1Id]: 0, [session.player2Id]: 0 },
    turn: 1,
    startTime: new Date().toISOString()
  };
}

// Helper: Initialize pool balls
function initializeBalls() {
  const balls = [];
  // Cue ball (white)
  balls.push({ id: 0, type: 'cue', position: { x: -0.5, y: 0, z: 0 }, potted: false });
  
  // Numbered balls 1-7 (solids)
  for (let i = 1; i <= 7; i++) {
    balls.push({ id: i, type: 'solid', number: i, position: null, potted: false });
  }
  
  // 8-ball (black)
  balls.push({ id: 8, type: 'eight', position: { x: 0, y: 0, z: 0 }, potted: false });
  
  // Numbered balls 9-15 (stripes)
  for (let i = 9; i <= 15; i++) {
    balls.push({ id: i, type: 'stripe', number: i, position: null, potted: false });
  }
  
  return balls;
}
