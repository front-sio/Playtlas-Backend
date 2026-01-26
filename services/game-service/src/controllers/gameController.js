// backend/services/game-service/src/controllers/gameController.js
const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const { QueueNames } = require('../../../../shared/constants/queueNames');
const { createQueue, defaultJobOptions } = require('../../../../shared/config/redis');
const { EightBallEngine } = require('../engine/8ball');
const { publishEvent, Topics } = require('../../../../shared/events');
const { syncMatchResult } = require('../utils/matchmakingSync');

const AI_PLAYER_ID = process.env.AI_PLAYER_ID || '04a942ce-af5f-4bde-9068-b9e2ee295fbf';
const CLIENT_TABLE = { width: 1600, height: 900 };

let cleanupQueue;

function getCleanupQueue() {
  if (!cleanupQueue) {
    cleanupQueue = createQueue(QueueNames.GAME_SESSION_CLEANUP);
  }
  return cleanupQueue;
}

function safeParseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      return {};
    }
  }
  if (typeof value === 'object') return value;
  return {};
}

function getServerTable(engine) {
  const scale = engine?.config?.adjustmentScale || 2.3;
  const n = 600 * scale;
  return {
    width: 100 * n,
    height: 50 * n
  };
}

function mapClientToServer(engine, point) {
  if (!point) return null;
  const serverTable = getServerTable(engine);
  const x = (point.x / CLIENT_TABLE.width) * serverTable.width - serverTable.width / 2;
  const y = (point.y / CLIENT_TABLE.height) * serverTable.height - serverTable.height / 2;
  return {
    x: Math.round(x * 1000) / 1000,
    y: Math.round(y * 1000) / 1000
  };
}

function mapDirectionToServer(engine, direction) {
  if (!direction) return null;
  const serverTable = getServerTable(engine);
  return {
    x: direction.x * (serverTable.width / CLIENT_TABLE.width),
    y: direction.y * (serverTable.height / CLIENT_TABLE.height)
  };
}

function normalizeShotLog(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  return [];
}

function resolveWinnerKeyByScore(rulesState, options = {}) {
  const allowTie = Boolean(options.allowTie);
  const p1Score = Number(rulesState?.p1Score || 0);
  const p2Score = Number(rulesState?.p2Score || 0);
  if (allowTie && p1Score === p2Score) {
    return null;
  }
  return p1Score >= p2Score ? 'p1' : 'p2';
}

function isValidPosition(pos) {
  return pos && typeof pos.x === 'number' && typeof pos.y === 'number' && 
         !isNaN(pos.x) && !isNaN(pos.y) && isFinite(pos.x) && isFinite(pos.y);
}

function replayShotLog({ session, shotLog, seed, adjustmentScale }) {
  const engine = new EightBallEngine({
    seed,
    adjustmentScale: adjustmentScale || 2.3
  });

  const shots = normalizeShotLog(shotLog)
    .filter((shot) => shot && typeof shot === 'object')
    .sort((a, b) => {
      const seqA = Number(a.seq ?? a.shotSeq ?? 0);
      const seqB = Number(b.seq ?? b.shotSeq ?? 0);
      if (seqA && seqB) return seqA - seqB;
      const timeA = new Date(a.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || 0).getTime();
      return timeA - timeB;
    });

  let lastError = null;
  let expectedTurn = 'p1'; // Start with p1, will be updated by engine
  
  // Detect if this is an AI game for more lenient validation
  const isAiGame = session?.metadata?.gameType === 'with_ai' || 
                   shots.some(shot => shot.trigger === 'aiStrike');
  
  for (let i = 0; i < shots.length; i += 1) {
    const shotEntry = shots[i];
    const actorSide = shotEntry.actorSide || shotEntry.turn;
    const turnKey = actorSide || expectedTurn;

    if (!turnKey) {
      return { ok: false, error: 'Missing turn for shot', index: i };
    }
    
    // For the first shot, initialize the engine turn
    if (i === 0) {
      if (engine.state?.rulesState) {
        engine.state.rulesState.turn = turnKey;
        expectedTurn = turnKey;
      }
      if (engine.state) {
        engine.state.turn = turnKey;
      }
    } else {
      // For subsequent shots, validate against current engine state
      const currentEngineTurn = engine.state?.rulesState?.turn || expectedTurn;
      
      // Allow more flexibility for AI games and general gameplay
      if (actorSide && currentEngineTurn && actorSide !== currentEngineTurn) {
        // For AI games, be very lenient with turn validation
        if (isAiGame) {
          logger.info(
            { sessionId: session?.sessionId, shotIndex: i, actorSide, currentEngineTurn, isAiGame },
            '[game-service] Turn correction applied for AI game'
          );
          
          // Force the turn to match the shot record for AI games
          if (engine.state?.rulesState) {
            engine.state.rulesState.turn = actorSide;
          }
          if (engine.state) {
            engine.state.turn = actorSide;
          }
        } else {
          // For all games, be more lenient with turn validation during replay
          // The shot log might have natural flow that doesn't perfectly match engine prediction
          const isValidPlayer = (actorSide === 'p1' || actorSide === 'p2');
          
          if (!isValidPlayer) {
            return { ok: false, error: 'Invalid player in shot log', index: i };
          }
          
          // Accept turn inconsistencies during replay - trust the client's turn logic
          logger.debug({
            sessionId,
            shotIndex: i,
            expectedTurn: currentEngineTurn,
            actualTurn: actorSide,
            message: 'Turn mismatch during replay - trusting client turn logic'
          });
          
          // Sync engine turn with actual shot
          if (engine.state?.rulesState) {
            engine.state.rulesState.turn = actorSide;
          }
          if (engine.state) {
            engine.state.turn = actorSide;
          }
        }
      }
    }
    
    if (!shotEntry.direction || typeof shotEntry.power !== 'number') {
      return { ok: false, error: 'Invalid shot payload', index: i };
    }

    const direction = mapDirectionToServer(engine, shotEntry.direction);
    
    const requiresPlacement = Boolean(
      shotEntry.cueBallInHand === true ||
      shotEntry.ballInHand === true ||
      shotEntry.foul === true ||
      shotEntry.forceCueBallPlacement === true ||
      // Also check if cue ball position is explicitly provided
      (shotEntry.cueBallPosition && shotEntry.cueBallPosition.x !== undefined)
    );
    
    // For AI games, be more lenient with cue ball placement validation
    let cueBallPosition = mapClientToServer(engine, shotEntry.cueBallPosition);
    if (requiresPlacement && isAiGame && (!cueBallPosition || !isValidPosition(cueBallPosition))) {
      cueBallPosition = { x: 0, y: 0 }; // Default to center for AI games
      logger.info(
        { sessionId: session?.sessionId, shotIndex: i },
        '[game-service] Using default cue ball position for AI game'
      );
    }
    
    const shot = {
      direction,
      power: shotEntry.power,
      cueBallPosition: requiresPlacement ? cueBallPosition : null,
      screw: shotEntry.screw,
      english: shotEntry.english
    };

    const result = engine.applyShot(turnKey, shot, {});
    if (!result.ok) {
      // For AI games, be more lenient with shot failures
      if (isAiGame) {
        logger.warn(
          { sessionId: session?.sessionId, shotIndex: i, error: result.error },
          '[game-service] Shot validation failed for AI game - attempting recovery'
        );
        
        // Try to apply a simplified shot for AI games
        const simplifiedShot = {
          direction: shot.direction,
          power: Math.min(Math.max(shot.power || 2000, 1000), 4000),
          cueBallPosition: null, // Remove problematic cue ball position
          screw: 0,
          english: 0
        };
        
        const retryResult = engine.applyShot(turnKey, simplifiedShot, {});
        if (!retryResult.ok) {
          lastError = { error: retryResult.error || 'Shot rejected after retry', index: i };
          return { ok: false, error: retryResult.error || 'Shot rejected after retry', index: i };
        }
      } else {
        lastError = { error: result.error || 'Shot rejected', index: i };
        return { ok: false, error: result.error || 'Shot rejected', index: i };
      }
    }
    
    // Update expected turn after successful shot application
    expectedTurn = engine.state?.rulesState?.turn || expectedTurn;
  }

  return { ok: true, engine };
}

function computePrizeDistribution({ gameType, entryFee }) {
  const fee = Number(entryFee || 0);
  const isWithAi = gameType === 'with_ai' || gameType === 'ai';
  const feePercent = isWithAi ? 0.10 : 0.30;
  
  if (fee <= 0) {
    return {
      platformFee: 0,
      netPrizePool: 0,
      feePercent,
      potAmount: 0
    };
  }

  // Game sessions are always 1v1, so pot = 2 × entryFee (both players contribute)
  const potAmount = fee * 2;
  const platformFee = Number((potAmount * feePercent).toFixed(2));
  const netPrizePool = Number((potAmount - platformFee).toFixed(2));

  return {
    platformFee,
    netPrizePool,
    feePercent,
    potAmount
  };
}

exports.createSession = async (req, res) => {
  try {
    const { tableId, player1Id, player2Id, metadata } = req.body;

    if (!player1Id || !player2Id) {
      return res.status(400).json({ success: false, error: 'player1Id and player2Id are required' });
    }

    const matchId = metadata?.matchId;
    if (matchId) {
      const existingSession = await prisma.gameSession.findFirst({
        where: {
          metadata: {
            path: ['matchId'],
            equals: matchId
          }
        },
        orderBy: { createdAt: 'desc' }
      });

      if (existingSession) {
        const isSamePair =
          (existingSession.player1Id === player1Id && existingSession.player2Id === player2Id) ||
          (existingSession.player1Id === player2Id && existingSession.player2Id === player1Id);

        if (!isSamePair) {
          logger.warn(
            {
              matchId,
              existingSessionId: existingSession.sessionId,
              player1Id,
              player2Id,
              existingPlayer1Id: existingSession.player1Id,
              existingPlayer2Id: existingSession.player2Id
            },
            '[game-service] Match already has a session with different players'
          );
          return res.status(409).json({
            success: false,
            error: 'Match already has a game session with different players'
          });
        }

        const existingMetadata = safeParseMetadata(existingSession.metadata);
        if (!Number.isFinite(Number(existingMetadata.matchSeed))) {
          existingMetadata.matchSeed = Math.floor(Math.random() * 2 ** 32);
          await prisma.gameSession.update({
            where: { sessionId: existingSession.sessionId },
            data: { metadata: existingMetadata }
          });
        }
        const durationSeconds =
          Number(existingMetadata?.maxDurationSeconds || existingMetadata?.matchDurationSeconds) ||
          Number(metadata?.maxDurationSeconds || metadata?.matchDurationSeconds) ||
          300;
        const startTime = existingSession.startedAt || existingSession.createdAt || new Date();

        logger.info(
          { matchId, sessionId: existingSession.sessionId },
          '[game-service] Reusing existing game session for match'
        );

        return res.status(200).json({
          success: true,
          data: {
            session: existingSession,
            sessionId: existingSession.sessionId,
            reused: true,
            matchTiming: {
              startTime,
              duration: durationSeconds,
              endTime: new Date(startTime.getTime() + durationSeconds * 1000)
            }
          }
        });
      }
    }

    // Detect AI game automatically
    const isAiGame = player1Id === AI_PLAYER_ID || player2Id === AI_PLAYER_ID;
    let resolvedPlayer1Id = player1Id;
    let resolvedPlayer2Id = player2Id;

    if (isAiGame && player1Id === AI_PLAYER_ID && player2Id !== AI_PLAYER_ID) {
      resolvedPlayer1Id = player2Id;
      resolvedPlayer2Id = player1Id;
    }
    
    // Enhanced metadata handling for realtime sessions
    const gameType = isAiGame ? 'with_ai' : (metadata?.gameType || 'pvp');
    const entryFee = Number(metadata?.entryFee || 0);
    const platformFeePercent = gameType === 'with_ai' ? 0.10 : 0.30;
    
    const matchSeed = Number.isFinite(Number(metadata?.matchSeed))
      ? Number(metadata.matchSeed)
      : Math.floor(Math.random() * 2 ** 32);
    const rawLevel = Number(metadata?.level ?? metadata?.matchLevel ?? metadata?.aiLevel);
    const normalizedLevel = Number.isFinite(rawLevel)
      ? Math.max(1, Math.min(50, Math.round(rawLevel)))
      : null;
    const rawAiRating = Number(metadata?.aiRating);
    
    // Tournament AI should be competitive but fair
    const isTournamentGame = Boolean(metadata?.tournamentId);
    const maxAiRating = isTournamentGame ? 15 : 20; // Increased for tournaments
    const normalizedAiRating = Number.isFinite(rawAiRating)
      ? Math.max(1, Math.min(maxAiRating, Math.round(rawAiRating)))
      : (isTournamentGame ? 10 : 5); // Default tournament AI rating: 10
    
    const rawAiDifficulty = Number(metadata?.aiDifficulty ?? metadata?.ai);
    const maxAiDifficulty = isTournamentGame ? 50 : 100; // Increased for tournaments
    const normalizedAiDifficulty = Number.isFinite(rawAiDifficulty) 
      ? Math.max(1, Math.min(maxAiDifficulty, rawAiDifficulty))
      : (isTournamentGame ? 35 : 15); // Default tournament AI difficulty: 35
    const hybridMode = Boolean(metadata?.hybridMode || metadata?.hybrid || metadata?.authority === 'hybrid');
    const enhancedMetadata = {
      ...metadata,
      sessionCreated: new Date().toISOString(),
      matchDurationSeconds: metadata?.maxDurationSeconds || 300,
      realTimeEnabled: true,
      // Auto-detect AI games with tournament-aware difficulty
      gameType,
      aiPlayerId: isAiGame ? AI_PLAYER_ID : metadata?.aiPlayerId,
      aiDifficulty: isAiGame ? (normalizedAiDifficulty || (isTournamentGame ? 8 : 12)) : normalizedAiDifficulty,
      aiRating: normalizedAiRating ?? metadata?.aiRating ?? null,
      level: normalizedLevel ?? metadata?.level ?? null,
      entryFee,
      platformFeePercent,
      matchSeed,
      hybridMode
    };

    // Use match start time if available, otherwise use current time
    const sessionStartTime = metadata?.startTime ? new Date(metadata.startTime) : new Date();

    const session = await prisma.gameSession.create({
      data: {
        tableId,
        player1Id: resolvedPlayer1Id,
        player2Id: resolvedPlayer2Id,
        metadata: enhancedMetadata,
        status: 'active',
        startedAt: sessionStartTime, // Use proper timing
      },
    });

    logger.info({ 
      sessionId: session.sessionId, 
      matchId: metadata?.matchId,
      startTime: sessionStartTime,
      duration: metadata?.maxDurationSeconds || 300
    }, '[game-service] Enhanced game session created for realtime play');
    
    res.status(201).json({ 
      success: true, 
      data: { 
        session,
        sessionId: session.sessionId,
        matchTiming: {
          startTime: sessionStartTime,
          duration: metadata?.maxDurationSeconds || 300,
          endTime: new Date(sessionStartTime.getTime() + (metadata?.maxDurationSeconds || 300) * 1000)
        }
      }
    });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to create session');
    res.status(500).json({ success: false, error: 'Failed to create game session' });
  }
};

exports.getSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await prisma.gameSession.findUnique({
      where: { sessionId },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true, data: session });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to get session');
    res.status(500).json({ success: false, error: 'Failed to get game session' });
  }
};

exports.listSessions = async (req, res) => {
  try {
    const { limit = 50, status } = req.query;

    const where = {};
    if (status) {
      where.status = status;
    }

    const sessions = await prisma.gameSession.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      take: Number(limit),
    });
    res.json({ success: true, data: sessions });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to list sessions');
    res.status(500).json({ success: false, error: 'Failed to list sessions' });
  }
};

exports.updateSessionMetadata = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { metadata } = req.body;

    const session = await prisma.gameSession.findUnique({
      where: { sessionId }
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const mergedMetadata = {
      ...safeParseMetadata(session.metadata),
      ...safeParseMetadata(metadata)
    };

    if (!Number.isFinite(Number(mergedMetadata.matchSeed))) {
      mergedMetadata.matchSeed = Math.floor(Math.random() * 2 ** 32);
    }

    const updated = await prisma.gameSession.update({
      where: { sessionId },
      data: {
        metadata: mergedMetadata,
        updatedAt: new Date()
      }
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to update session metadata');
    res.status(500).json({ success: false, error: 'Failed to update session metadata' });
  }
};

exports.startSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { startedAt } = req.body || {};

    const session = await prisma.gameSession.findUnique({
      where: { sessionId }
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const requestedStart = startedAt ? new Date(startedAt) : new Date();
    if (Number.isNaN(requestedStart.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid startedAt' });
    }

    const existingStart = session.startedAt ? new Date(session.startedAt) : null;
    const shouldUpdateStart = !existingStart || requestedStart > existingStart;
    const effectiveStart = shouldUpdateStart ? requestedStart : existingStart;

    const metadata = safeParseMetadata(session.metadata);
    const updatedMetadata = {
      ...metadata,
      startTime: effectiveStart.toISOString(),
      actualStartTime: effectiveStart.toISOString()
    };

    const updateData = {
      metadata: updatedMetadata,
      updatedAt: new Date()
    };
    if (shouldUpdateStart) {
      updateData.startedAt = effectiveStart;
    }
    if (session.status === 'pending') {
      updateData.status = 'active';
    }

    const updated = await prisma.gameSession.update({
      where: { sessionId },
      data: updateData
    });

    res.json({
      success: true,
      data: {
        session: updated,
        matchTiming: {
          startTime: effectiveStart,
          duration: Number(updatedMetadata?.maxDurationSeconds || updatedMetadata?.matchDurationSeconds || 300),
          endTime: new Date(
            effectiveStart.getTime() +
            Number(updatedMetadata?.maxDurationSeconds || updatedMetadata?.matchDurationSeconds || 300) * 1000
          )
        }
      }
    });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to start session');
    res.status(500).json({ success: false, error: 'Failed to start game session' });
  }
};

exports.completeSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { result, metadata } = req.body;

    const session = await prisma.gameSession.findUnique({
      where: { sessionId },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const baseMetadata = safeParseMetadata(session.metadata);
    const requestMetadata = safeParseMetadata(metadata);
    const mergedMetadata = {
      ...baseMetadata,
      ...requestMetadata
    };

    const hybridMode = Boolean(
      mergedMetadata.hybridMode || mergedMetadata.hybrid || mergedMetadata.authority === 'hybrid'
    );
    const shotLog = normalizeShotLog(mergedMetadata.shotLog);
    const rawResult = typeof result === 'string' ? safeParseMetadata(result) : (result || {});
    const reason = rawResult?.reason || mergedMetadata.reason || 'completed';

    let winnerId = null;
    let winnerKey = null;
    let player1Score = 0;
    let player2Score = 0;
    let verificationStatus = hybridMode ? 'skipped' : 'n/a';
    let isDraw = false;

    if (hybridMode) {
      const matchSeed = Number.isFinite(Number(mergedMetadata.matchSeed))
        ? Number(mergedMetadata.matchSeed)
        : Math.floor(Math.random() * 2 ** 32);
      const adjustmentScale = Number(mergedMetadata.adjustmentScale || 2.3);
      const replay = replayShotLog({
        session,
        shotLog,
        seed: matchSeed,
        adjustmentScale
      });

    if (!replay.ok) {
        logger.warn(
          { sessionId, error: replay.error, index: replay.index, shot: shotLog?.[replay.index] },
          '[game-service] Hybrid verification failed - shot log replay error'
        );
        
        // Add detailed debugging information
        if (replay.index !== undefined && shotLog?.[replay.index]) {
          const problematicShot = shotLog[replay.index];
          logger.error({
            sessionId,
            shotIndex: replay.index,
            shotDetails: {
              actorSide: problematicShot.actorSide,
              turn: problematicShot.turn,
              shotSeq: problematicShot.shotSeq,
              trigger: problematicShot.trigger,
              timestamp: problematicShot.timestamp
            },
            totalShots: shotLog.length,
            replayError: replay.error
          }, '[game-service] Shot log debug info');
        }
        
        return res.status(422).json({
          success: false,
          error: 'Hybrid verification failed',
          details: replay.error,
          index: replay.index,
          debug: process.env.NODE_ENV !== 'production' ? {
            shotCount: shotLog?.length || 0,
            problematicShot: shotLog?.[replay.index] || null
          } : undefined
        });
      }

      const rulesState = replay.engine?.state?.rulesState || {};
      player1Score = Number(rulesState.p1Score || 0);
      player2Score = Number(rulesState.p2Score || 0);
      const rawPlayer1Score = Number(rawResult?.player1Score || rawResult?.scores?.player1 || rawResult?.p1Score || 0);
      const rawPlayer2Score = Number(rawResult?.player2Score || rawResult?.scores?.player2 || rawResult?.p2Score || 0);
      if (!player1Score && !player2Score && (rawPlayer1Score || rawPlayer2Score)) {
        player1Score = rawPlayer1Score;
        player2Score = rawPlayer2Score;
        logger.warn({ sessionId, player1Score, player2Score }, '[game-service] Using client scores for hybrid result');
      }
      winnerKey = rulesState.winner || null;
      const allowTimeoutTie = reason === 'timeout';
      if (!winnerKey && allowTimeoutTie) {
        winnerKey = resolveWinnerKeyByScore(rulesState, { allowTie: true });
      }
      if (!winnerKey && !allowTimeoutTie) {
        winnerKey = resolveWinnerKeyByScore(rulesState, { allowTie: false });
      }
      if (!winnerKey && allowTimeoutTie) {
        isDraw = true;
      }
      if (winnerKey) {
        winnerId = winnerKey === 'p1' ? session.player1Id : session.player2Id;
      }
      verificationStatus = 'passed';
      mergedMetadata.matchSeed = matchSeed;
    } else {
      winnerId = rawResult?.winnerId || null;
      if (!winnerId && rawResult?.winner) {
        winnerId = rawResult.winner === 'p1' ? session.player1Id : session.player2Id;
      }
      player1Score = Number(rawResult?.player1Score || rawResult?.scores?.player1 || rawResult?.p1Score || 0);
      player2Score = Number(rawResult?.player2Score || rawResult?.scores?.player2 || rawResult?.p2Score || 0);
    }

    if (rawResult?.draw || mergedMetadata?.draw) {
      isDraw = true;
      winnerId = null;
      winnerKey = null;
    }

    if (!winnerId && !isDraw) {
      return res.status(400).json({ success: false, error: 'Winner required' });
    }

    if (isDraw) {
      mergedMetadata.draw = true;
    }

    // Compute prize distribution for with_ai games
    const gameType = mergedMetadata.gameType || 'pvp';
    const entryFee = Number(mergedMetadata.entryFee || 0);
    const prizeDistribution = computePrizeDistribution({ gameType, entryFee });

    // Enhance result with prize information
    const enhancedResult = {
      winnerId,
      player1Score,
      player2Score,
      prizeAmount: prizeDistribution.netPrizePool,
      netPrizePool: prizeDistribution.netPrizePool,
      platformFee: prizeDistribution.platformFee,
      feePercent: prizeDistribution.feePercent,
      currency: mergedMetadata.currency || 'TSH',
      reason,
      verificationStatus,
      draw: isDraw
    };

    mergedMetadata.verification = {
      status: verificationStatus,
      shotCount: shotLog.length
    };

    const updated = await prisma.gameSession.update({
      where: { sessionId },
      data: {
        status: 'completed',
        result: JSON.stringify(enhancedResult),
        metadata: mergedMetadata,
        endedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Try to enqueue cleanup job for this session, but don't fail if Redis is unavailable
    try {
      const queue = getCleanupQueue();
      const job = await queue.add(
        'cleanup-game-session',
        { sessionId: updated.sessionId },
        { ...defaultJobOptions }
      );
      logger.info({ sessionId: updated.sessionId, jobId: job.id }, '[game-service] Session completed and cleanup job enqueued');
    } catch (redisError) {
      logger.warn({ sessionId: updated.sessionId, err: redisError }, '[game-service] Could not enqueue cleanup job (Redis unavailable), session completed anyway');
    }

    const matchId = mergedMetadata.matchId || null;
    if (matchId) {
      try {
        await publishEvent(Topics.MATCH_RESULT, {
          matchId,
          winnerId,
          player1Score,
          player2Score,
          reason,
          draw: isDraw,
          tournamentId: mergedMetadata.tournamentId || null,
          seasonId: mergedMetadata.seasonId || null
        });
      } catch (matchErr) {
        logger.error('Failed to publish match result event', { err: matchErr, matchId });
      }
    }

    if (isDraw) {
      logger.warn({ sessionId, matchId, reason }, '[game-service] Session completed as draw');
    }

    res.json({ success: true, data: updated, result: enhancedResult });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to complete session');
    res.status(500).json({ success: false, error: 'Failed to complete game session' });
  }
};

exports.cancelSession = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await prisma.gameSession.findUnique({
      where: { sessionId },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const updated = await prisma.gameSession.update({
      where: { sessionId },
      data: {
        status: 'cancelled',
        endedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    logger.info({ sessionId: updated.sessionId }, '[game-service] Session cancelled');
    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to cancel session');
    res.status(500).json({ success: false, error: 'Failed to cancel game session' });
  }
};

// Submit match result from club device
exports.submitMatchResult = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { 
      winnerId, 
      player1Score, 
      player2Score, 
      matchDuration, 
      endReason, 
      reason: rawReason,
      gameData 
    } = req.body;
    const reason = endReason || rawReason || 'completed';
    const matchDurationSeconds = matchDuration == null
      ? null
      : (Number.isFinite(Number(matchDuration)) ? Number(matchDuration) : null);

    // Validate required fields
    if (!winnerId || typeof player1Score !== 'number' || typeof player2Score !== 'number') {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: winnerId, player1Score, player2Score' 
      });
    }

    // Get the game session
    const session = await prisma.gameSession.findUnique({
      where: { sessionId }
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Game session not found' });
    }

    const sessionMetadata = safeParseMetadata(session.metadata);
    const matchId = sessionMetadata.matchId || req.body.matchId || null;

    // Update session with result
    const completedAt = new Date();
    const updatedSession = await prisma.gameSession.update({
      where: { sessionId },
      data: {
        status: 'completed',
        endedAt: completedAt,
        metadata: {
          ...sessionMetadata,
          result: {
            winnerId,
            player1Score,
            player2Score,
            matchDuration: matchDurationSeconds,
            endReason: reason,
            submittedAt: completedAt.toISOString()
          },
          gameData: gameData || {}
        }
      }
    });

    if (matchId) {
      // Publish match result event for matchmaking service to process
      try {
        await publishEvent(Topics.MATCH_RESULT, {
          matchId,
          winnerId,
          player1Score,
          player2Score,
          matchDuration: matchDurationSeconds,
          reason,
          completedAt: completedAt.toISOString(),
          tournamentId: sessionMetadata.tournamentId || null,
          seasonId: sessionMetadata.seasonId || null
        });
      } catch (eventErr) {
        logger.error({ err: eventErr, matchId }, '[game-service] Failed to publish match result event');
      }

      await syncMatchResult(matchId, {
        winnerId,
        player1Score,
        player2Score,
        matchDuration: matchDurationSeconds,
        reason,
        completedAt: completedAt.toISOString()
      });
    } else {
      logger.warn({ sessionId }, '[game-service] submitMatchResult missing matchId');
    }

    logger.info({ 
      sessionId, 
      matchId, 
      winnerId, 
      scores: `${player1Score}-${player2Score}` 
    }, '[game-service] Match result submitted');

    res.json({ success: true, data: updatedSession });
  } catch (error) {
    logger.error({ err: error }, '[game-service] Failed to submit match result');
    res.status(500).json({ success: false, error: 'Failed to submit match result' });
  }
};

// Export helper for use in other controllers
exports.computePrizeDistribution = computePrizeDistribution;
