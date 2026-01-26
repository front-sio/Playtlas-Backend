// backend/services/game-service/src/controllers/authoritativeGameController.js
/**
 * AUTHORITATIVE GAME CONTROLLER
 * Integrates ServerGameManager with existing match/session system
 * Handles HTTP endpoints for server-side game execution
 */

const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const ServerGameManager = require('../engine/8ball/server-game-manager');
const { publishEvent, Topics } = require('../../../../shared/events');
const crypto = require('crypto');

// In-memory game instances (production should use Redis for multi-instance)
const activeGames = new Map(); // matchId -> ServerGameManager

// Configuration
const AI_PLAYER_ID = process.env.AI_PLAYER_ID || '04a942ce-af5f-4bde-9068-b9e2ee295fbf';
const GAME_TIMEOUT = 30 * 60 * 1000; // 30 minutes

/**
 * Initialize a new authoritative game session
 * POST /api/game/authoritative/init
 */
exports.initGame = async (req, res) => {
  try {
    const { matchId, gameType, aiDifficulty, player1Id, player2Id } = req.body;

    if (!matchId) {
      return res.status(400).json({
        success: false,
        error: 'matchId is required'
      });
    }

    // Check if game already exists
    if (activeGames.has(matchId)) {
      logger.info(`[AuthController] Game already exists for match ${matchId}`);
      const existingGame = activeGames.get(matchId);
      return res.status(200).json({
        success: true,
        data: {
          matchId,
          gameState: existingGame.getGameState(),
          message: 'Game already initialized'
        }
      });
    }

    // Determine game type
    const isAiGame = player2Id === AI_PLAYER_ID || gameType === 'with_ai';

    // Create game instance
    const rawDifficulty = Number(aiDifficulty ?? 3); // Default to level 3 instead of 50
    const normalizedDifficulty = Number.isFinite(rawDifficulty)
      ? Math.max(1, Math.min(20, Math.round(rawDifficulty))) // Cap at 20 for fair play
      : 3;
    const game = new ServerGameManager({
      matchId,
      gameType: isAiGame ? 'with_ai' : 'multiplayer',
      aiDifficulty: normalizedDifficulty
    });

    activeGames.set(matchId, game);

    // Set timeout to cleanup inactive games
    setTimeout(() => {
      if (activeGames.has(matchId)) {
        const gameState = activeGames.get(matchId).getGameState();
        if (!gameState.gameOver) {
          logger.warn(`[AuthController] Cleaning up inactive game ${matchId}`);
        }
        activeGames.delete(matchId);
      }
    }, GAME_TIMEOUT);

    logger.info(`[AuthController] Initialized authoritative game for match ${matchId}`, {
      gameType: isAiGame ? 'with_ai' : 'multiplayer',
      aiDifficulty: isAiGame ? aiDifficulty : null
    });

    return res.status(201).json({
      success: true,
      data: {
        matchId,
        gameState: game.getGameState(),
        gameType: isAiGame ? 'with_ai' : 'multiplayer',
        message: 'Authoritative game initialized'
      }
    });

  } catch (error) {
    logger.error('[AuthController] Error initializing game', { error, body: req.body });
    return res.status(500).json({
      success: false,
      error: 'Failed to initialize game'
    });
  }
};

/**
 * Execute a shot
 * POST /api/game/authoritative/:matchId/shot
 */
exports.executeShot = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { direction, power, cueBallPosition, screw, english } = req.body;
    const playerId = req.user?.userId || req.body.playerId;

    if (!playerId) {
      return res.status(401).json({
        success: false,
        error: 'Player authentication required'
      });
    }

    // Get game instance
    const game = activeGames.get(matchId);
    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found or expired'
      });
    }

    // Validate shot data
    if (!direction || typeof direction.x !== 'number' || typeof direction.y !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'Invalid shot direction'
      });
    }

    if (typeof power !== 'number' || power < 0 || power > 6000) {
      return res.status(400).json({
        success: false,
        error: 'Invalid shot power (must be 0-6000)'
      });
    }

    // Prepare shot data
    const shotData = {
      direction: {
        x: direction.x,
        y: direction.y
      },
      power: power,
      cueBallPosition: cueBallPosition || null,
      screw: screw || 0,
      english: english || 0
    };

    // Determine player side (p1 or p2)
    const gameState = game.getGameState();
    let playerSide = null;
    
    // Get match to determine player sides
    const match = await prisma.match.findUnique({
      where: { matchId: matchId }
    });

    if (!match) {
      return res.status(404).json({
        success: false,
        error: 'Match not found'
      });
    }

    if (match.player1Id === playerId) {
      playerSide = 'p1';
    } else if (match.player2Id === playerId) {
      playerSide = 'p2';
    } else {
      return res.status(403).json({
        success: false,
        error: 'Player not in this match'
      });
    }

    // Execute shot
    const result = await game.executeShot(shotData, playerSide);

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Save shot to database
    try {
      await prisma.gameShot.create({
        data: {
          matchId: matchId,
          shotNumber: result.result.shotNumber,
          playerId: playerSide,
          directionX: direction.x,
          directionY: direction.y,
          power: power,
          cueBallX: cueBallPosition?.x,
          cueBallY: cueBallPosition?.y,
          screw: screw,
          english: english,
          resultState: result.result,
          pocketedBalls: result.result.pocketed,
          fouls: result.result.fouls,
          firstContact: result.result.firstContact,
          stateHash: result.result.stateHash,
          executionTime: result.result.executionTime,
          executedAt: new Date()
        }
      });
    } catch (dbError) {
      logger.error('[AuthController] Failed to save shot to database', { dbError, matchId });
      // Continue anyway - game state is in memory
    }

    // Publish event for real-time updates
    try {
      await publishEvent(Topics.GAME_STATE_UPDATED, {
        matchId,
        shotNumber: result.result.shotNumber,
        playerId: playerSide,
        result: result.result,
        timestamp: Date.now()
      });
    } catch (eventError) {
      logger.error('[AuthController] Failed to publish game state event', { eventError, matchId });
    }

    // Check if game is over
    if (result.result.gameOver) {
      await handleGameEnd(matchId, game, match);
    }

    return res.status(200).json({
      success: true,
      data: result.result
    });

  } catch (error) {
    logger.error('[AuthController] Error executing shot', { error, matchId: req.params.matchId });
    return res.status(500).json({
      success: false,
      error: 'Failed to execute shot'
    });
  }
};

/**
 * Execute AI turn
 * POST /api/game/authoritative/:matchId/ai-turn
 */
exports.executeAiTurn = async (req, res) => {
  try {
    const { matchId } = req.params;

    const game = activeGames.get(matchId);
    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found'
      });
    }

    // Check if it's AI's turn
    const gameState = game.getGameState();
    const match = await prisma.match.findUnique({
      where: { matchId: matchId }
    });

    if (!match) {
      return res.status(404).json({
        success: false,
        error: 'Match not found'
      });
    }

    const isAiP2 = match.player2Id === AI_PLAYER_ID;
    const isAiTurn = (isAiP2 && gameState.turn === 'p2') || (!isAiP2 && gameState.turn === 'p1');

    if (!isAiTurn) {
      return res.status(400).json({
        success: false,
        error: 'Not AI turn'
      });
    }

    // Execute AI turn
    const result = await game.executeAiTurn();

    if (!result.success) {
      return res.status(500).json(result);
    }

    // Save to database
    try {
      await prisma.gameShot.create({
        data: {
          matchId: matchId,
          shotNumber: result.result.shotNumber,
          playerId: gameState.turn,
          directionX: result.result.direction?.x || 0,
          directionY: result.result.direction?.y || 0,
          power: result.result.power || 0,
          resultState: result.result,
          pocketedBalls: result.result.pocketed,
          fouls: result.result.fouls,
          firstContact: result.result.firstContact,
          stateHash: result.result.stateHash,
          executionTime: result.result.executionTime,
          executedAt: new Date()
        }
      });
    } catch (dbError) {
      logger.error('[AuthController] Failed to save AI shot', { dbError, matchId });
    }

    // Publish event
    try {
      await publishEvent(Topics.GAME_STATE_UPDATED, {
        matchId,
        shotNumber: result.result.shotNumber,
        playerId: 'ai',
        result: result.result,
        timestamp: Date.now()
      });
    } catch (eventError) {
      logger.error('[AuthController] Failed to publish AI shot event', { eventError, matchId });
    }

    // Check if game over
    if (result.result.gameOver) {
      await handleGameEnd(matchId, game, match);
    }

    return res.status(200).json({
      success: true,
      data: result.result
    });

  } catch (error) {
    logger.error('[AuthController] Error executing AI turn', { error, matchId: req.params.matchId });
    return res.status(500).json({
      success: false,
      error: 'Failed to execute AI turn'
    });
  }
};

/**
 * Get current game state
 * GET /api/game/authoritative/:matchId/state
 */
exports.getGameState = async (req, res) => {
  try {
    const { matchId } = req.params;

    const game = activeGames.get(matchId);
    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found'
      });
    }

    const state = game.getGameState();

    return res.status(200).json({
      success: true,
      data: state
    });

  } catch (error) {
    logger.error('[AuthController] Error getting game state', { error, matchId: req.params.matchId });
    return res.status(500).json({
      success: false,
      error: 'Failed to get game state'
    });
  }
};

/**
 * Handle game end - update match, process payments
 */
async function handleGameEnd(matchId, game, match) {
  try {
    const gameState = game.getGameState();
    const winner = gameState.winner;

    logger.info(`[AuthController] Game ended for match ${matchId}, winner: ${winner}`);

    // Determine winner player ID
    let winnerPlayerId = null;
    if (winner === 'p1') {
      winnerPlayerId = match.player1Id;
    } else if (winner === 'p2') {
      winnerPlayerId = match.player2Id;
    }

    // Update match status
    await prisma.match.update({
      where: { matchId: matchId },
      data: {
        status: 'completed',
        winnerId: winnerPlayerId,
        completedAt: new Date(),
        player1Score: gameState.p1Score || 0,
        player2Score: gameState.p2Score || 0,
        metadata: {
          ...match.metadata,
          gameResult: {
            winner: winner,
            p1Score: gameState.p1Score,
            p2Score: gameState.p2Score,
            totalShots: gameState.shotNumber,
            stateHash: game.generateStateHash()
          }
        }
      }
    });

    if (winnerPlayerId) {
      await publishEvent(Topics.MATCH_RESULT, {
        matchId,
        winnerId: winnerPlayerId,
        player1Score: gameState.p1Score,
        player2Score: gameState.p2Score,
        reason: 'completed'
      });
    }

    // Clean up game instance after short delay
    setTimeout(() => {
      activeGames.delete(matchId);
      logger.info(`[AuthController] Cleaned up game instance for ${matchId}`);
    }, 60000); // Keep for 1 minute for any final queries

  } catch (error) {
    logger.error('[AuthController] Error handling game end', { error, matchId });
  }
}

/**
 * Get game statistics
 * GET /api/game/authoritative/stats
 */
exports.getStats = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        activeGames: activeGames.size,
        games: Array.from(activeGames.keys())
      }
    });
  } catch (error) {
    logger.error('[AuthController] Error getting stats', { error });
    return res.status(500).json({
      success: false,
      error: 'Failed to get stats'
    });
  }
};

module.exports = exports;
