// backend/services/game-service/src/controllers/gameSocketController.js
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
const DEBUG_STATE = process.env.DEBUG_GAME_STATE === 'true';
const AI_PLAYER_ID = process.env.AI_PLAYER_ID || '04a942ce-af5f-4bde-9068-b9e2ee295fbf';
const AI_THINKING_MIN_MS = Number(process.env.AI_THINKING_MIN_MS || 600);
const AI_THINKING_MAX_MS = Number(process.env.AI_THINKING_MAX_MS || 1400);

const aiShotLocks = new Map(); // sessionId -> boolean

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseSessionMetadata(session) {
  if (!session?.metadata) return {};
  if (typeof session.metadata === 'string') {
    try {
      return JSON.parse(session.metadata || '{}');
    } catch (err) {
      logger.warn({ err, sessionId: session.sessionId }, 'Failed to parse game session metadata');
      return {};
    }
  }
  return session.metadata || {};
}

function normalizeMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata);
    } catch (err) {
      return {};
    }
  }
  if (typeof metadata === 'object') return metadata;
  return {};
}

function mergeSessionMetadata(session, metadata) {
  return {
    ...parseSessionMetadata(session),
    ...normalizeMetadata(metadata)
  };
}

function getAiSide(session) {
  if (!session) return null;
  const metadata = parseSessionMetadata(session);
  const aiPlayerId = metadata?.aiPlayerId || AI_PLAYER_ID;
  if (!aiPlayerId) return null;
  if (session.player1Id === aiPlayerId) return 'p1';
  if (session.player2Id === aiPlayerId) return 'p2';
  return null;
}

function getAiDifficulty(metadata) {
  const raw = Number(metadata?.aiDifficulty || 5);
  if (!Number.isFinite(raw)) return 5;
  return clamp(Math.round(raw), 1, 100);
}

function findTargetBall(engine, targetType) {
  const balls = engine.state.balls;
  const cueBall = balls[0];
  const candidates = [];
  for (let i = 1; i < balls.length; i += 1) {
    const ball = balls[i];
    if (!ball || ball.active !== 1) continue;
    if (targetType === 'SOLIDS' && ball.id >= 1 && ball.id <= 7) {
      candidates.push(ball);
    } else if (targetType === 'STRIPES' && ball.id >= 9) {
      candidates.push(ball);
    } else if (targetType === '8' && ball.id === 8) {
      candidates.push(ball);
    } else if (targetType === 'ANY' && ball.id !== 8) {
      candidates.push(ball);
    }
  }

  if (candidates.length === 0) {
    for (let i = 1; i < balls.length; i += 1) {
      const ball = balls[i];
      if (ball && ball.active === 1) {
        candidates.push(ball);
      }
    }
  }

  if (!cueBall || candidates.length === 0) return null;
  let best = candidates[0];
  let bestDist = Infinity;
  candidates.forEach((ball) => {
    const dx = ball.position.x - cueBall.position.x;
    const dy = ball.position.y - cueBall.position.y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = ball;
    }
  });
  return best;
}

function countLegalPocketed(pocketed, targetType) {
  if (!pocketed || pocketed.length === 0) return 0;
  if (targetType === 'ANY') {
    return pocketed.filter((ballId) => ballId !== 8).length;
  }
  if (targetType === 'SOLIDS') {
    return pocketed.filter((ballId) => ballId > 0 && ballId < 8).length;
  }
  if (targetType === 'STRIPES') {
    return pocketed.filter((ballId) => ballId > 8).length;
  }
  if (targetType === '8') {
    return pocketed.includes(8) ? 1 : 0;
  }
  return 0;
}

function scoreSimulatedShot({ rulesState, shotResult, aiSide, targetType }) {
  let score = 0;
  if (!rulesState) return -Infinity;
  if (rulesState.winner === aiSide) score += 10000;
  if (rulesState.foul) score -= 2000;
  if (shotResult?.cueScratch) score -= 1000;
  const legalCount = countLegalPocketed(shotResult?.pocketed || [], targetType);
  const totalPocketed = shotResult?.pocketed?.length || 0;
  score += legalCount * 250;
  score -= (totalPocketed - legalCount) * 100;
  if (rulesState.turn === aiSide) score += 200;
  if (totalPocketed > 0) score += 50;
  return score;
}

function buildDirectShotCandidates(engine, cueBall, targetBall, pockets, accuracy) {
  const candidates = [];
  const ballRadius = engine.config.ballRadius;
  const maxPower = engine.config.maxPower;
  pockets.forEach((pocket) => {
    const toPocketX = pocket.position.x - targetBall.position.x;
    const toPocketY = pocket.position.y - targetBall.position.y;
    const toPocketMag = Math.hypot(toPocketX, toPocketY);
    if (toPocketMag < ballRadius * 2) return;
    const toPocketUnitX = toPocketX / toPocketMag;
    const toPocketUnitY = toPocketY / toPocketMag;
    const ghostX = targetBall.position.x - toPocketUnitX * ballRadius * 2;
    const ghostY = targetBall.position.y - toPocketUnitY * ballRadius * 2;
    const dx = ghostX - cueBall.position.x;
    const dy = ghostY - cueBall.position.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 1) return;
    const baseAngle = Math.atan2(dy, dx);
    const maxOffset = (1 - accuracy) * (Math.PI / 6);
    const angle = baseAngle + (Math.random() * 2 - 1) * maxOffset;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const distance = mag + toPocketMag;
    const basePower = clamp(distance * 0.06, 900, maxPower * 0.95);
    const jitter = (1 - accuracy) * 500;
    const power = clamp(basePower + (Math.random() * 2 - 1) * jitter, 700, maxPower * 0.95);
    candidates.push({ direction, power });
  });
  return candidates;
}

function buildBankShotCandidates(engine, cueBall, targetBall, pockets, accuracy) {
  const candidates = [];
  const bounds = engine.getTableBounds();
  const reflections = [];
  pockets.forEach((pocket) => {
    reflections.push({ x: 2 * bounds.left - pocket.position.x, y: pocket.position.y });
    reflections.push({ x: 2 * bounds.right - pocket.position.x, y: pocket.position.y });
    reflections.push({ x: pocket.position.x, y: 2 * bounds.top - pocket.position.y });
    reflections.push({ x: pocket.position.x, y: 2 * bounds.bottom - pocket.position.y });
  });

  const ballRadius = engine.config.ballRadius;
  const maxPower = engine.config.maxPower;
  reflections.forEach((refPocket) => {
    const toPocketX = refPocket.x - targetBall.position.x;
    const toPocketY = refPocket.y - targetBall.position.y;
    const toPocketMag = Math.hypot(toPocketX, toPocketY);
    if (toPocketMag < ballRadius * 2) return;
    const toPocketUnitX = toPocketX / toPocketMag;
    const toPocketUnitY = toPocketY / toPocketMag;
    const ghostX = targetBall.position.x - toPocketUnitX * ballRadius * 2;
    const ghostY = targetBall.position.y - toPocketUnitY * ballRadius * 2;
    const dx = ghostX - cueBall.position.x;
    const dy = ghostY - cueBall.position.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 1) return;
    const baseAngle = Math.atan2(dy, dx);
    const maxOffset = (1 - accuracy) * (Math.PI / 4);
    const angle = baseAngle + (Math.random() * 2 - 1) * maxOffset;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const distance = mag + toPocketMag;
    const basePower = clamp(distance * 0.07, 1100, maxPower * 0.98);
    const jitter = (1 - accuracy) * 700;
    const power = clamp(basePower + (Math.random() * 2 - 1) * jitter, 900, maxPower * 0.98);
    candidates.push({ direction, power });
  });
  return candidates;
}

function buildRandomShots(engine, accuracy, count) {
  const shots = [];
  const maxPower = engine.config.maxPower;
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const basePower = clamp(1500 + Math.random() * 2200, 800, maxPower * 0.95);
    const jitter = (1 - accuracy) * 800;
    const power = clamp(basePower + (Math.random() * 2 - 1) * jitter, 700, maxPower * 0.98);
    shots.push({
      direction: { x: Math.cos(angle), y: Math.sin(angle) },
      power
    });
  }
  return shots;
}

function pickCueBallPlacement(engine, targetBall) {
  if (!engine.state.cueBallInHand) return null;
  const bounds = engine.getTableBounds();
  const snapshot = engine.getSnapshot();
  const testEngine = new EightBallEngine({ ...engine.config, seed: snapshot.seed });
  testEngine.loadState(snapshot);
  if (!targetBall) {
    const center = { x: 0, y: 0 };
    if (testEngine.placeCueBall(center)) return center;
    return { x: bounds.left, y: bounds.top };
  }
  const dx = targetBall.position.x;
  const dy = targetBall.position.y;
  const mag = Math.hypot(dx, dy) || 1;
  const offset = engine.config.ballRadius * 6;
  const rawX = targetBall.position.x - (dx / mag) * offset;
  const rawY = targetBall.position.y - (dy / mag) * offset;
  const candidate = {
    x: clamp(rawX, bounds.left, bounds.right),
    y: clamp(rawY, bounds.top, bounds.bottom)
  };
  if (testEngine.placeCueBall(candidate)) return candidate;
  const fallback = { x: 0, y: 0 };
  if (testEngine.placeCueBall(fallback)) return fallback;
  return null;
}

function chooseAiShot(engine, aiSide, difficulty) {
  const rulesState = engine.state.rulesState || {};
  const targetType = aiSide === 'p1' ? rulesState.p1Target : rulesState.p2Target;
  const cueBall = engine.state.balls[0];
  const targetBall = findTargetBall(engine, targetType);
  const normalized = clamp(difficulty / 100, 0.1, 1);
  const accuracy = clamp(0.2 + Math.pow(normalized, 1.3) * 0.8, 0.2, 1);
  const pockets = engine.table.pockets || [];
  const snapshot = engine.getSnapshot();
  const attempts = clamp(Math.round(12 + difficulty * 0.6), 12, 80);
  const randomCount = clamp(Math.round(2 + (1 - accuracy) * 6), 2, 10);
  const cueBallPosition = pickCueBallPlacement(engine, targetBall);

  if (!cueBall || !targetBall) {
    const fallback = buildRandomShots(engine, accuracy, 1)[0];
    return { ...fallback, cueBallPosition };
  }

  const candidates = [
    ...buildDirectShotCandidates(engine, cueBall, targetBall, pockets, accuracy),
    ...buildBankShotCandidates(engine, cueBall, targetBall, pockets, accuracy),
    ...buildRandomShots(engine, accuracy, randomCount)
  ];

  let best = null;
  let bestScore = -Infinity;
  const cappedCandidates = candidates.slice(0, Math.max(attempts, 1));
  for (const candidate of cappedCandidates) {
    const testEngine = new EightBallEngine({ ...engine.config, seed: snapshot.seed });
    testEngine.loadState(snapshot);
    const simulated = testEngine.applyShot(aiSide, {
      direction: candidate.direction,
      power: candidate.power,
      cueBallPosition: cueBallPosition || undefined,
      screw: 0,
      english: 0
    });
    if (!simulated.ok) continue;
    const score = scoreSimulatedShot({
      rulesState: testEngine.state.rulesState,
      shotResult: simulated.shotResult,
      aiSide,
      targetType
    });
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best) {
    best = buildRandomShots(engine, accuracy, 1)[0];
  }
  return { ...best, cueBallPosition };
}

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
  
  // PRECISION FIX: Use higher precision for client-to-server mapping
  const x = (point.x / CLIENT_TABLE.width) * serverTable.width - serverTable.width / 2;
  const y = (point.y / CLIENT_TABLE.height) * serverTable.height - serverTable.height / 2;
  
  return {
    x: Math.round(x * 1000) / 1000, // Precision to 3 decimal places
    y: Math.round(y * 1000) / 1000,
  };
}

function mapServerToClient(engine, point) {
  if (!point) return null;
  const serverTable = getServerTable(engine);
  
  // PRECISION FIX: Use higher precision floating point arithmetic
  const x = ((point.x + serverTable.width / 2) / serverTable.width) * CLIENT_TABLE.width;
  const y = ((point.y + serverTable.height / 2) / serverTable.height) * CLIENT_TABLE.height;
  
  return {
    x: Math.round(x * 1000) / 1000, // Precision to 3 decimal places
    y: Math.round(y * 1000) / 1000,
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
  
  // PRECISION FIX: Higher precision velocity mapping
  const velX = velocity.x * (CLIENT_TABLE.width / serverTable.width);
  const velY = velocity.y * (CLIENT_TABLE.height / serverTable.height);
  
  return {
    x: Math.round(velX * 1000) / 1000,
    y: Math.round(velY * 1000) / 1000,
  };
}

async function completeGameSession({ io, sessionId, winnerKey, winnerId: explicitWinnerId, rulesState, metadata }) {
  const session = await prisma.gameSession.findUnique({
    where: { sessionId }
  });

  if (!session) return;

  const winnerId = explicitWinnerId || (winnerKey === 'p1' ? session.player1Id : session.player2Id);
  let resolvedRulesState = {};
  try {
    const engine = await getOrCreateEngine(session);
    resolvedRulesState = engine?.state?.rulesState || {};
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to load engine rules state for scores');
  }
  const player1Score = Number(resolvedRulesState?.p1Score || 0);
  const player2Score = Number(resolvedRulesState?.p2Score || 0);

  // Compute prize distribution
  const sessionMetadata = parseSessionMetadata(session);
  const gameType = sessionMetadata.gameType || 'pvp';
  const entryFee = Number(sessionMetadata.entryFee || 0);
  const platformFeePercent = gameType === 'with_ai' ? 0.10 : 0.30;
  
  let prizeAmount = 0;
  let netPrizePool = 0;
  let platformFee = 0;
  
  if (entryFee > 0) {
    const potAmount = gameType === 'with_ai' ? entryFee * 2 : entryFee * 2;
    platformFee = Number((potAmount * platformFeePercent).toFixed(2));
    netPrizePool = Number((potAmount - platformFee).toFixed(2));
    prizeAmount = netPrizePool; // Single winner gets full prize
  }

  const enhancedResult = {
    winnerId,
    player1Score,
    player2Score,
    prizeAmount,
    netPrizePool,
    platformFee,
    feePercent: platformFeePercent
  };

  await prisma.gameSession.update({
    where: { sessionId },
    data: {
      status: 'completed',
      result: enhancedResult,
      metadata: mergeSessionMetadata(session, metadata),
      endedAt: new Date()
    }
  });

  io.to(`game:${sessionId}`).emit('game:completed', {
    winnerId,
    player1Score,
    player2Score,
    prizeAmount,
    timestamp: new Date().toISOString()
  });

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

  logger.info(`Game session ${sessionId} completed. Winner: ${winnerId}, Prize: ${prizeAmount}`);
}

function checkMatchTimeout(session) {
  if (!session?.metadata) return false;
  
  let sessionMetadata = {};
  if (typeof session.metadata === 'string') {
    try {
      sessionMetadata = JSON.parse(session.metadata);
    } catch (err) {
      return false;
    }
  } else {
    sessionMetadata = session.metadata;
  }

  const maxDurationSeconds = sessionMetadata.maxDurationSeconds || 300;
  
  // Use consistent timing logic - prefer actual start time, fallback to creation time
  // Avoid using scheduledTime which might be very old
  const startTime = sessionMetadata.startTime ? 
    new Date(sessionMetadata.startTime) : 
    new Date(session.startedAt || session.createdAt);
    
  const now = new Date();
  const elapsedSeconds = Math.max(0, (now - startTime) / 1000);

  // Add safety check for invalid dates
  if (!startTime || isNaN(startTime.getTime())) {
    logger.warn({ sessionId: session.sessionId }, 'Invalid start time detected, defaulting to not expired');
    return false;
  }

  const isExpired = elapsedSeconds >= maxDurationSeconds;
  
  if (isExpired) {
    logger.info({ 
      sessionId: session.sessionId, 
      elapsedSeconds: Math.round(elapsedSeconds), 
      maxDurationSeconds,
      startTime: startTime.toISOString()
    }, 'Session timeout detected');
  }

  return isExpired;
}

function resolveWinnerByScore(session, rulesState) {
  if (!session) return null;
  const p1Score = Number(rulesState?.p1Score || 0);
  const p2Score = Number(rulesState?.p2Score || 0);
  if (p1Score === p2Score) return session.player1Id;
  return p1Score > p2Score ? session.player1Id : session.player2Id;
}

function buildClientStateFromSnapshot(session, engine, snapshot) {
  const engineState = snapshot.state;
  const rulesState = engineState.rulesState || {};
  const turnKey = rulesState.turn || 'p1';
  const currentPlayerId = turnKey === 'p1' ? session.player1Id : session.player2Id;
  const balls = engineState.balls
    .filter(Boolean)
    .map((ball) => ({
      id: ball.id,
      pos: mapServerToClient(engine, {
        x: ball.position?.x ?? ball.position?.xValue,
        y: ball.position?.y ?? ball.position?.yValue
      }),
      vel: mapVelocityToClient(engine, {
        x: ball.velocity?.x ?? ball.velocity?.xValue,
        y: ball.velocity?.y ?? ball.velocity?.yValue
      }),
      active: ball.active === 1,
    }));

  // Calculate time information
  let sessionMetadata = {};
  if (typeof session.metadata === 'string') {
    try {
      sessionMetadata = JSON.parse(session.metadata);
    } catch (err) {
      sessionMetadata = {};
    }
  } else {
    sessionMetadata = session.metadata || {};
  }
  
  const maxDurationSeconds = sessionMetadata.maxDurationSeconds || 300;
  // Use proper match timing - prefer actual start time over scheduled time
  const startTime = sessionMetadata.startTime ? 
    new Date(sessionMetadata.startTime) : 
    sessionMetadata.scheduledTime ? 
      new Date(sessionMetadata.scheduledTime) : 
      new Date(session.startedAt || session.createdAt);
  
  const now = new Date();
  const elapsedSeconds = Math.max(0, (now - startTime) / 1000);
  const timeRemainingSeconds = Math.max(0, maxDurationSeconds - elapsedSeconds);

  const clientState = {
    balls,
    turn: turnKey,
    p1Target: rulesState.p1Target || 'ANY',
    p2Target: rulesState.p2Target || 'ANY',
    ballInHand: rulesState.ballInHand || engineState.cueBallInHand,
    winner: rulesState.winner || engineState.winner,
    foul: rulesState.foul || false,
    shotNumber: rulesState.shotNumber || 0,
    p1Score: rulesState.p1Score || 0,
    p2Score: rulesState.p2Score || 0,
    message: rulesState.message || '',
    timeRemainingSeconds: Math.floor(timeRemainingSeconds),
    matchStartTime: startTime.toISOString(),
    matchActualStartTime: sessionMetadata.startTime || null, // Include actual match start time
    maxDurationSeconds,
  };

  return {
    engineSnapshot: snapshot,
    clientState,
    rulesState,
    currentPlayer: currentPlayerId,
    turn: turnKey,
    cueBallInHand: engineState.cueBallInHand,
    winner: engineState.winner,
    player1Id: session.player1Id,
    player2Id: session.player2Id,
    timeRemainingSeconds: Math.floor(timeRemainingSeconds),
    matchStartTime: startTime.toISOString(),
  };
}

function buildClientState(session, engine) {
  return buildClientStateFromSnapshot(session, engine, engine.getSnapshot());
}

function broadcastFrames({ io, session, engine, frames }) {
  if (!frames || frames.length === 0) return;
  
  const token = Date.now();
  sessionBroadcastTokens.set(session.sessionId, token);
  
  // SYNC FIX: Improved frame timing for better interpolation
  const totalDuration = 2000; // Total animation duration in ms
  const intervalMs = totalDuration / frames.length; // Dynamic interval based on frame count
  
  logger.info(`Broadcasting ${frames.length} frames over ${totalDuration}ms (${intervalMs}ms intervals)`);

  frames.forEach((frame, idx) => {
    setTimeout(() => {
      if (sessionBroadcastTokens.get(session.sessionId) !== token) return;
      
      const payload = buildClientStateFromSnapshot(session, engine, frame);
      io.to(`game:${session.sessionId}`).emit('game:state_updated', {
        gameState: payload,
        tick: idx + 1,
        totalTicks: frames.length,
        timestamp: new Date().toISOString(),
        frameInterval: intervalMs // Help client with interpolation timing
      });
    }, idx * intervalMs);
  });
  
  // Clear broadcasting token after all frames are sent
  setTimeout(() => {
    if (sessionBroadcastTokens.get(session.sessionId) === token) {
      sessionBroadcastTokens.delete(session.sessionId);
    }
  }, totalDuration + 500);
}

async function applyShotAndBroadcast({ io, session, engine, turnKey, shot }) {
  const shotResult = engine.applyShot(turnKey, shot, {
    capture: {
      stride: CAPTURE_STRIDE,
      maxFrames: MAX_FRAMES
    }
  });

  if (!shotResult.ok) {
    return { ok: false, error: shotResult.error || 'Shot rejected' };
  }

  const updatedState = buildClientState(session, engine);
  await prisma.gameSession.update({
    where: { sessionId: session.sessionId },
    data: {
      gameState: updatedState,
      lastActivityAt: new Date()
    }
  });

  if (shotResult.frames && shotResult.frames.length > 0) {
    broadcastFrames({ io, session, engine, frames: shotResult.frames });
  } else {
    io.to(`game:${session.sessionId}`).emit('game:state_updated', {
      gameState: updatedState,
      shotResult: shotResult.shotResult,
      timestamp: new Date().toISOString()
    });
    if (DEBUG_STATE) {
      logger.info({
        sessionId: session.sessionId,
        currentPlayer: updatedState?.currentPlayer,
        turn: updatedState?.turn,
        ballCount: updatedState?.clientState?.balls?.length
      }, '[game-state] game:state_updated payload');
    }
  }

  return { ok: true, updatedState };
}

async function scheduleAiTurn({ io, session, engine }) {
  const aiSide = getAiSide(session);
  if (!aiSide) {
    logger.debug({ sessionId: session.sessionId }, '[ai] No AI side detected, skipping AI turn');
    return;
  }
  
  // More flexible AI game detection: if AI player is present, allow AI turns
  const metadata = parseSessionMetadata(session);
  const hasAiGameType = metadata?.gameType === 'with_ai' || metadata?.gameType === 'ai';
  const hasAiPlayer = aiSide !== null;
  
  if (!hasAiGameType && !hasAiPlayer) {
    logger.debug({ sessionId: session.sessionId, gameType: metadata?.gameType }, '[ai] Game type not AI compatible and no AI player detected, skipping AI turn');
    return;
  }
  
  if (!hasAiGameType) {
    logger.info({ sessionId: session.sessionId, aiSide }, '[ai] AI player detected without explicit game type - proceeding with AI turn');
  }
  
  const rulesState = engine.state.rulesState || {};
  const turnKey = rulesState.turn || 'p1';
  
  logger.info({ 
    sessionId: session.sessionId, 
    currentTurn: turnKey, 
    aiSide, 
    isAiTurn: turnKey === aiSide,
    hasWinner: !!engine.state.winner,
    isLocked: !!aiShotLocks.get(session.sessionId)
  }, '[ai] Turn check');
  
  if (turnKey !== aiSide) {
    logger.debug({ sessionId: session.sessionId, currentTurn: turnKey, aiSide }, '[ai] Not AI turn, skipping');
    return;
  }
  if (engine.state.winner) {
    logger.debug({ sessionId: session.sessionId, winner: engine.state.winner }, '[ai] Game already has winner, skipping AI turn');
    return;
  }
  if (aiShotLocks.get(session.sessionId)) {
    logger.debug({ sessionId: session.sessionId }, '[ai] AI shot already in progress, skipping');
    return;
  }

  logger.info({ sessionId: session.sessionId, aiSide, difficulty: getAiDifficulty(metadata) }, '[ai] Scheduling AI turn');
  
  aiShotLocks.set(session.sessionId, true);
  const delay = clamp(
    AI_THINKING_MIN_MS + Math.random() * (AI_THINKING_MAX_MS - AI_THINKING_MIN_MS),
    100,
    5000
  );

  setTimeout(async () => {
    try {
      const difficulty = getAiDifficulty(metadata);
      logger.info({ sessionId: session.sessionId, aiSide, difficulty, delay }, '[ai] Executing AI turn after delay');
      
      const shotBase = chooseAiShot(engine, aiSide, difficulty);
      const fallbackPlacement = engine.state.cueBallInHand && !shotBase.cueBallPosition
        ? { x: 0, y: 0 }
        : undefined;
      const shot = {
        direction: shotBase.direction,
        power: shotBase.power,
        cueBallPosition: shotBase.cueBallPosition || fallbackPlacement,
        screw: 0,
        english: 0
      };

      logger.info({ 
        sessionId: session.sessionId, 
        power: shot.power, 
        direction: shot.direction,
        cueBallPosition: shot.cueBallPosition
      }, '[ai] AI shot calculated');

      const applied = await applyShotAndBroadcast({
        io,
        session,
        engine,
        turnKey: aiSide,
        shot
      });

      if (!applied.ok) {
        logger.warn({ sessionId: session.sessionId, error: applied.error }, '[ai] Shot rejected');
        return;
      }

      logger.info({ sessionId: session.sessionId }, '[ai] AI shot applied successfully');

      if (applied.updatedState?.winner) {
        await completeGameSession({
          io,
          sessionId: session.sessionId,
          winnerKey: applied.updatedState.winner,
          rulesState: applied.updatedState.rulesState
        });
        return;
      }

      await scheduleAiTurn({ io, session, engine });
    } catch (err) {
      logger.error({ err, sessionId: session.sessionId }, '[ai] Failed to execute AI turn');
    } finally {
      aiShotLocks.delete(session.sessionId);
    }
  }, delay);
}

async function getOrCreateEngine(session) {
  const existing = sessionEngines.get(session.sessionId);
  if (existing) return existing;

  const metadata = parseSessionMetadata(session);
  const difficulty = getAiDifficulty(metadata);
  
  const engine = new EightBallEngine();
  
  // Set AI difficulty if provided
  if (metadata?.gameType === 'with_ai' && difficulty) {
    logger.info({ sessionId: session.sessionId, difficulty }, '[ai] Setting AI difficulty for engine');
  }
  
  let needsInitialStateSave = false;
  
  if (session.gameState) {
    try {
      const parsed = typeof session.gameState === 'string'
        ? JSON.parse(session.gameState)
        : session.gameState;
      engine.loadState(parsed?.engineSnapshot || parsed);
    } catch (error) {
      logger.warn({ err: error, sessionId: session.sessionId }, 'Failed to parse gameState for engine');
      needsInitialStateSave = true;
    }
  } else {
    // No gameState yet, need to persist initial state
    needsInitialStateSave = true;
  }
  
  sessionEngines.set(session.sessionId, engine);
  
  // Persist initial game state if it wasn't in the database
  if (needsInitialStateSave) {
    try {
      const initialState = buildClientState(session, engine);
      await prisma.gameSession.update({
        where: { sessionId: session.sessionId },
        data: { gameState: initialState }
      });
      logger.info({ sessionId: session.sessionId }, 'Saved initial game state to database');
    } catch (error) {
      logger.warn({ err: error, sessionId: session.sessionId }, 'Failed to save initial game state');
    }
  }
  
  return engine;
}

async function ensureAiAutoJoin({ io, session }) {
  const metadata = parseSessionMetadata(session);
  const aiSide = getAiSide(session);
  
  if (!aiSide) {
    logger.debug({ sessionId: session.sessionId }, '[ai] No AI side detected in ensureAiAutoJoin');
    return;
  }

  const isWithAi = metadata?.gameType === 'with_ai' || metadata?.gameType === 'ai';
  if (!isWithAi) {
    logger.debug({ sessionId: session.sessionId, gameType: metadata?.gameType }, '[ai] Not a with_ai game type');
    return;
  }

  logger.info({ sessionId: session.sessionId, aiSide }, '[ai] Auto-joining AI to session');

  // Mark AI as connected and ready
  const aiReadyUpdate = aiSide === 'p1' 
    ? { player1Ready: true, player1Connected: true }
    : { player2Ready: true, player2Connected: true };

  await prisma.gameSession.update({
    where: { sessionId: session.sessionId },
    data: aiReadyUpdate
  });

  // Broadcast AI joined event
  const aiPlayerId = metadata?.aiPlayerId || AI_PLAYER_ID;
  const engine = await getOrCreateEngine(session);
  const gameState = buildClientState(session, engine);

  io.to(`game:${session.sessionId}`).emit('game:joined', {
    sessionId: session.sessionId,
    playerId: aiPlayerId,
    gameState,
    aiPlayer: true
  });

  logger.info({ sessionId: session.sessionId, aiSide }, '[ai] AI auto-joined successfully');

  // If AI starts, schedule its first turn
  const rulesState = engine.state.rulesState || {};
  const turnKey = rulesState.turn || 'p1';
  if (turnKey === aiSide) {
    logger.info({ sessionId: session.sessionId, aiSide }, '[ai] AI has first turn, scheduling');
    await scheduleAiTurn({ io, session, engine });
  }
}

exports.setupGameSocketHandlers = function(io) {
  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (instance ${INSTANCE_ID})`);
    
    let authenticatedPlayerId = null;
    let currentSessionId = null;

    // Authentication
    socket.on('authenticate', async ({ playerId, token }) => {
      try {
        if (!playerId) {
          socket.emit('auth_error', { error: 'Missing playerId' });
          return;
        }
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

        const aiSide = getAiSide(session);
        if (aiSide === 'p1') {
          connectionData.player1Connected = true;
        }
        if (aiSide === 'p2') {
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
        
        // Re-fetch session after engine initialization to get the latest gameState
        const updatedSession = await prisma.gameSession.findUnique({
          where: { sessionId }
        });
        
        const gameState = buildClientState(updatedSession || session, engine);
        await prisma.gameSession.update({
          where: { sessionId },
          data: {
            gameState,
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
        if (DEBUG_STATE) {
          logger.info({
            sessionId,
            playerId: authenticatedPlayerId,
            currentPlayer: gameState?.currentPlayer,
            turn: gameState?.turn,
            ballCount: gameState?.clientState?.balls?.length
          }, '[game-state] game:joined payload');
        }

        if (aiSide) {
          const aiReadyUpdate = aiSide === 'p1' ? { player1Ready: true, player1Connected: true } : { player2Ready: true, player2Connected: true };
          await prisma.gameSession.update({
            where: { sessionId },
            data: aiReadyUpdate
          });
        }

        // Ensure AI auto-joins for with_ai games
        await ensureAiAutoJoin({ io, session });

        // Check if both players are connected
        if (connectionData.player1Connected && connectionData.player2Connected) {
          io.to(`game:${sessionId}`).emit('game:ready', {
            message: 'Both players connected. Game starting!'
          });
          
          // Schedule AI turn if game is ready and it's AI's turn
          if (aiSide) {
            const currentEngine = await getOrCreateEngine(session);
            await scheduleAiTurn({ io, session, engine: currentEngine });
          }
        }
        
        // Also schedule AI turn if only AI is connected and game should start
        // This handles cases where human player disconnects or AI should go first
        if (aiSide && connectionData.player1Connected !== connectionData.player2Connected) {
          const currentEngine = await getOrCreateEngine(session);
          // Small delay to ensure game state is ready
          setTimeout(async () => {
            await scheduleAiTurn({ io, session, engine: currentEngine });
          }, 1000);
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
          if (DEBUG_STATE) {
            logger.info({
              sessionId: currentSessionId,
              currentPlayer: parsedState?.currentPlayer,
              turn: parsedState?.turn,
              ballCount: parsedState?.clientState?.balls?.length
            }, '[game-state] game:start payload');
          }

          logger.info(`Game session ${currentSessionId} started`);
          await scheduleAiTurn({ io, session: updatedSession, engine });
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

        // Check if session has timed out
        if (checkMatchTimeout(session)) {
          const engineForTimeout = await getOrCreateEngine(session);
          const timeoutRules = engineForTimeout?.state?.rulesState || {};
          const timeoutWinnerId = resolveWinnerByScore(session, timeoutRules);
          await completeGameSession({
            io,
            sessionId: currentSessionId,
            winnerId: timeoutWinnerId,
            rulesState: { ...timeoutRules, timeout: true },
            metadata: { reason: 'timeout', resolution: 'score' }
          });
          return socket.emit('error', { message: 'Match time expired' });
        }

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
          const shot = {
            direction,
            power: data.power,
            cueBallPosition,
            screw: data.screw,
            english: data.english
          };

          const applied = await applyShotAndBroadcast({
            io,
            session,
            engine,
            turnKey: clientState.turn,
            shot
          });

          if (!applied.ok) {
            return socket.emit('error', { message: applied.error || 'Shot rejected' });
          }

          if (applied.updatedState?.winner) {
            await completeGameSession({
              io,
              sessionId: currentSessionId,
              winnerKey: applied.updatedState.winner,
              rulesState: applied.updatedState.rulesState
            });
          } else {
            await scheduleAiTurn({ io, session, engine });
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
        const session = await prisma.gameSession.findUnique({
          where: { sessionId: currentSessionId }
        });
        if (!session) {
          return socket.emit('error', { message: 'Game session not found' });
        }
        const engine = await getOrCreateEngine(session);
        const state = buildClientState(session, engine);
        if (!state?.winner) {
          return socket.emit('error', { message: 'Match not finished yet' });
        }
        const expectedWinnerId = state.winner === 'p1' ? session.player1Id : session.player2Id;
        if (winnerId !== expectedWinnerId) {
          return socket.emit('error', { message: 'Winner mismatch' });
        }
        await completeGameSession({
          io,
          sessionId: currentSessionId,
          winnerId: expectedWinnerId,
          rulesState: state.rulesState || { p1Score: player1Score, p2Score: player2Score },
          metadata
        });
      } catch (error) {
        logger.error({ err: error }, 'Game complete error');
        socket.emit('error', { message: 'Failed to complete game' });
      }
    });

    // Voice chat signaling for WebRTC
    socket.on('voice:signal', async ({ to, signal }) => {
      if (!authenticatedPlayerId || !currentSessionId) {
        return socket.emit('error', { message: 'Not in a game session' });
      }

      try {
        const session = await prisma.gameSession.findUnique({
          where: { sessionId: currentSessionId }
        });

        if (!session) {
          return socket.emit('error', { message: 'Session not found' });
        }

        // Verify the target player is in the same session
        if (to !== session.player1Id && to !== session.player2Id) {
          return socket.emit('error', { message: 'Invalid target player' });
        }

        // Verify the sender is authorized
        if (authenticatedPlayerId !== session.player1Id && authenticatedPlayerId !== session.player2Id) {
          return socket.emit('error', { message: 'Not authorized for this session' });
        }

        // Forward the signaling data to the target player
        socket.to(`game:${currentSessionId}`).emit('voice:signal', {
          from: authenticatedPlayerId,
          signal: signal
        });

        logger.info(`Voice signaling: ${authenticatedPlayerId} -> ${to} in session ${currentSessionId}`);
      } catch (error) {
        logger.error({ err: error }, 'Voice signaling error');
        socket.emit('error', { message: 'Voice signaling failed' });
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

// Periodic check for expired matches
let timeoutCheckInterval;

function startTimeoutChecker(io) {
  // Clear any existing interval
  if (timeoutCheckInterval) {
    clearInterval(timeoutCheckInterval);
  }
  
  // Check for expired matches every 30 seconds
  timeoutCheckInterval = setInterval(async () => {
    try {
      const activeSessions = await prisma.gameSession.findMany({
        where: {
          status: 'active'
        }
      });

      for (const session of activeSessions) {
        if (checkMatchTimeout(session)) {
          logger.info(`Auto-completing expired match session: ${session.sessionId}`);

          const engineForTimeout = await getOrCreateEngine(session);
          const timeoutRules = engineForTimeout?.state?.rulesState || {};
          const timeoutWinnerId = resolveWinnerByScore(session, timeoutRules);
          await completeGameSession({
            io,
            sessionId: session.sessionId,
            winnerId: timeoutWinnerId,
            rulesState: { ...timeoutRules, timeout: true },
            metadata: { reason: 'timeout', resolution: 'score' }
          });
          
          // Notify players in the room
          io.to(`game:${session.sessionId}`).emit('match:timeout', {
            message: 'Match time expired',
            sessionId: session.sessionId
          });
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error in timeout checker');
    }
  }, 30000); // Check every 30 seconds
}

// Export the timeout checker starter and testing functions
exports.startTimeoutChecker = startTimeoutChecker;
exports.getOrCreateEngine = getOrCreateEngine;
exports.scheduleAiTurn = scheduleAiTurn;
