// backend/services/game-service/src/engine/8ball/server-game-manager.js
/**
 * AUTHORITATIVE GAME MANAGER
 * Coordinates physics engine, AI, rules, and state management
 * This is the main entry point for server-side game execution
 */

const Ball = require('./server-ball');
const TableGeometry = require('./server-table');
const BilliardPhysics = require('./server-physics-engine');
const PoolAI = require('./server-ai');
const ShotValidator = require('./shot-validator');
const Vector2D = require('./server-vector2d');
const { Maths } = require('./server-maths');
const crypto = require('crypto');
const logger = require('../../utils/logger');

class ServerGameManager {
  constructor(matchConfig) {
    this.matchId = matchConfig.matchId;
    this.gameType = matchConfig.gameType || 'with_ai'; // 'with_ai' or 'multiplayer'
    const rawDifficulty = Number(matchConfig.aiDifficulty ?? 8);
    
    // For tournament games, use more controlled AI difficulty
    // Free play can have higher levels, but tournaments should be fair
    const isTournamentMatch = Boolean(matchConfig.tournamentId);
    const maxDifficulty = isTournamentMatch ? 25 : 100;
    const defaultDifficulty = isTournamentMatch ? 8 : 12;
    
    this.aiDifficulty = Number.isFinite(rawDifficulty)
      ? Math.max(1, Math.min(maxDifficulty, Math.round(rawDifficulty)))
      : defaultDifficulty;
    
    // Initialize components
    this.table = new TableGeometry();
    this.shotValidator = new ShotValidator();
    this.ai = new PoolAI(this.aiDifficulty, this.table);
    
    // Initialize game state
    this.initializeGame();
  }

  initializeGame() {
    // Create balls
    const positions = this.table.getRackPositions();
    this.balls = [];
    
    for (let i = 0; i < positions.length; i++) {
      if (positions[i]) {
        this.balls[i] = new Ball(i, positions[i], this.table.ballRadius);
      }
    }

    // Initialize physics engine
    this.physics = new BilliardPhysics({
      ballArray: this.balls,
      lineArray: this.table.lineArray,
      vertexArray: this.table.vertexArray || [],
      pocketArray: this.table.pocketArray,
      ballRadius: this.table.ballRadius,
      pocketRadius: this.table.config.pocketRadius,
      friction: this.table.config.friction,
      minVelocity: this.table.config.minVelocity,
      cushionRestitution: this.table.config.cushionRestitution,
      ballRestitution: this.table.config.ballRestitution
    });

    // Game state
    this.state = {
      matchId: this.matchId,
      shotNumber: 0,
      turn: 'p1',
      p1Target: 'ANY',
      p2Target: 'ANY',
      ballInHand: true, // Break shot
      cueBallInHand: true,
      scratched: false,
      winner: null,
      gameOver: false,
      p1Score: 0,
      p2Score: 0,
      lastShotTime: Date.now(),
      scratchOnBreak: false
    };
  }

  /**
   * Execute a shot from a player
   * This is the main entry point for shot execution
   */
  async executeShot(shotData, playerId) {
    const startTime = Date.now();
    
    try {
      // 1. Validate shot
      const validation = await this.shotValidator.validateShot(this.state, shotData, playerId);
      if (!validation.valid) {
        logger.warn(`[GameManager] Shot validation failed for ${playerId}`, validation);
        return {
          success: false,
          error: validation.error,
          message: validation.message
        };
      }

      // 2. Setup cue ball
      if (this.state.ballInHand && shotData.cueBallPosition) {
        this.balls[0].position.x = shotData.cueBallPosition.x;
        this.balls[0].position.y = shotData.cueBallPosition.y;
        this.balls[0].active = 1;
      }

      // 3. Apply shot to cue ball
      this.applyShotToCueBall(shotData);

      // 4. Run physics simulation
      const physicsResult = await this.runPhysicsSimulation();

      // 5. Apply 8-ball rules
      const rulesResult = this.applyRules(physicsResult);

      // 6. Update game state
      this.updateGameState(rulesResult);

      // 7. Generate result
      const result = this.generateShotResult(rulesResult, startTime);

      // 8. Check if AI should play next
      if (result.nextTurn === 'p2' && this.gameType === 'with_ai' && !this.state.gameOver) {
        result.aiWillPlayNext = true;
        result.aiThinkTime = this.ai.getThinkTime();
      }

      logger.info(`[GameManager] Shot executed successfully in ${Date.now() - startTime}ms`, {
        matchId: this.matchId,
        playerId,
        shotNumber: this.state.shotNumber
      });

      return {
        success: true,
        result: result
      };

    } catch (error) {
      logger.error('[GameManager] Error executing shot', { error, matchId: this.matchId, playerId });
      return {
        success: false,
        error: 'EXECUTION_ERROR',
        message: 'Failed to execute shot'
      };
    }
  }

  /**
   * Execute AI turn
   */
  async executeAiTurn() {
    try {
      logger.info(`[GameManager] AI calculating shot, difficulty: ${this.aiDifficulty}`);

      // AI calculates shot
      const aiShot = await this.ai.calculateShot({
        balls: this.balls.map(b => b.getState()),
        p2Target: this.state.p2Target,
        ballInHand: this.state.ballInHand,
        shotNumber: this.state.shotNumber
      });

      // Execute AI shot (no validation needed for AI)
      return await this.executeShot(aiShot, 'p2');

    } catch (error) {
      logger.error('[GameManager] AI turn error', { error, matchId: this.matchId });
      
      // Fallback: random shot
      const randomShot = {
        direction: { x: 1, y: 0 },
        power: 3000
      };
      return await this.executeShot(randomShot, 'p2');
    }
  }

  applyShotToCueBall(shotData) {
    const cueBall = this.balls[0];
    
    // Set velocity based on direction and power
    const direction = new Vector2D(shotData.direction.x, shotData.direction.y).normalize();
    cueBall.velocity = direction.times(shotData.power || 3000);

    // Apply spin if provided
    cueBall.screw = shotData.screw || 0;
    cueBall.english = shotData.english || 0;
    cueBall.ySpin = 0;
    cueBall.deltaScrew = new Vector2D(0, 0);
    cueBall.grip = 1;
    cueBall.firstContact = false;
    
    // Reset contact tracking for all balls
    for (const ball of this.balls) {
      ball.reset();
    }

    this.state.ballInHand = false;
    this.state.lastShotTime = Date.now();
  }

  async runPhysicsSimulation() {
    const MAX_FRAMES = 600; // 5 seconds at 120fps
    const CAPTURE_STRIDE = 3; // sample every 3 frames
    const MAX_SNAPSHOTS = 240;
    let frames = 0;
    const snapshots = [];

    this.physics.clearContactEvents();

    // Run until all balls stop or max frames reached
    while (!this.physics.isComplete() && frames < MAX_FRAMES) {
      this.physics.updatePhysics();
      frames++;
      if (frames % CAPTURE_STRIDE === 0 && snapshots.length < MAX_SNAPSHOTS) {
        snapshots.push(this.balls.map((ball) => ({
          id: ball.id,
          active: ball.active,
          position: { x: ball.position.x, y: ball.position.y }
        })));
      }
    }

    if (frames >= MAX_FRAMES) {
      logger.warn('[GameManager] Physics simulation reached max frames', {
        matchId: this.matchId
      });
      // Force stop all balls
      for (const ball of this.balls) {
        ball.velocity = new Vector2D(0, 0);
      }
    }

    // Collect results
    const pocketed = [];
    const cueBallPocketed = this.balls[0].active === 0;

    for (let i = 1; i < this.balls.length; i++) {
      const ball = this.balls[i];
      if (ball.active === 0) {
        pocketed.push(ball.id);
      }
    }

    // Get first contact
    let firstContact = null;
    const contactEvents = this.physics.getContactEvents();
    for (const event of contactEvents) {
      if (event.ball.id === 0 && event.type === 'ball') {
        firstContact = event.target.id;
        break;
      }
    }

    // Count cushion hits
    const cushionHits = new Set();
    for (const event of contactEvents) {
      if (event.type === 'line') {
        cushionHits.add(event.ball.id);
      }
    }

    return {
      pocketed,
      cueBallPocketed,
      firstContact,
      cushionHits: Array.from(cushionHits),
      frames,
      snapshots,
      frameStride: CAPTURE_STRIDE,
      frameTimeMs: 16,
      contactEvents
    };
  }

  applyRules(physicsResult) {
    const result = {
      ...physicsResult,
      fouls: [],
      turnOver: false,
      winner: null,
      ballInHand: false,
      groupAssigned: false
    };

    this.state.shotNumber++;

    // Check for scratched cue ball
    if (physicsResult.cueBallPocketed) {
      result.fouls.push('SCRATCHED');
      result.turnOver = true;
      result.ballInHand = true;
      this.state.scratched = true;
      
      if (this.state.shotNumber === 1) {
        this.state.scratchOnBreak = true;
      }

      // Re-activate cue ball
      this.balls[0].active = 1;
      this.balls[0].velocity = new Vector2D(0, 0);
    }

    // Check first contact
    const currentPlayer = this.state.turn;
    const playerTarget = currentPlayer === 'p1' ? this.state.p1Target : this.state.p2Target;

    if (!physicsResult.firstContact) {
      result.fouls.push('NO_CONTACT');
      result.turnOver = true;
    } else {
      const firstBall = this.balls[physicsResult.firstContact];
      
      if (playerTarget === 'SOLIDS' && firstBall.targetType !== 'SOLIDS') {
        result.fouls.push('WRONG_BALL_FIRST');
        result.turnOver = true;
      } else if (playerTarget === 'STRIPES' && firstBall.targetType !== 'STRIPES') {
        result.fouls.push('WRONG_BALL_FIRST');
        result.turnOver = true;
      } else if (playerTarget === '8 BALL' && firstBall.id !== 8) {
        result.fouls.push('WRONG_BALL_FIRST');
        result.turnOver = true;
      }
    }

    // Check pocketed balls
    if (physicsResult.pocketed.length > 0) {
      const pocketedTypes = { solids: 0, stripes: 0, eight: false };
      
      for (const ballId of physicsResult.pocketed) {
        const ball = this.balls[ballId];
        if (ball.targetType === 'SOLIDS') pocketedTypes.solids++;
        if (ball.targetType === 'STRIPES') pocketedTypes.stripes++;
        if (ball.id === 8) pocketedTypes.eight = true;
      }

      // Assign groups on first pot (if ANY)
      if (this.state.p1Target === 'ANY' && this.state.p2Target === 'ANY' && !pocketedTypes.eight) {
        if (pocketedTypes.solids > 0 && pocketedTypes.stripes === 0) {
          this.state.p1Target = 'SOLIDS';
          this.state.p2Target = 'STRIPES';
          result.groupAssigned = true;
        } else if (pocketedTypes.stripes > 0 && pocketedTypes.solids === 0) {
          this.state.p1Target = 'STRIPES';
          this.state.p2Target = 'SOLIDS';
          result.groupAssigned = true;
        }
      }

      // Check 8-ball pot
      if (pocketedTypes.eight) {
        if (playerTarget === '8 BALL' && result.fouls.length === 0) {
          // Legal 8-ball pot - player wins
          result.winner = currentPlayer;
        } else {
          // Illegal 8-ball pot - player loses
          result.winner = currentPlayer === 'p1' ? 'p2' : 'p1';
          result.fouls.push('ILLEGAL_8_BALL');
        }
      }

      // Continue turn if legal pot
      if (result.fouls.length === 0 && physicsResult.pocketed.length > 0 && !pocketedTypes.eight) {
        result.turnOver = false; // Keep turn
      } else if (result.fouls.length > 0) {
        result.turnOver = true;
      }
    }

    // Check if player cleared their group (can now pot 8-ball)
    if (playerTarget !== '8 BALL' && playerTarget !== 'ANY') {
      let groupRemaining = 0;
      for (const ball of this.balls) {
        if (ball.active && ball.targetType === playerTarget) {
          groupRemaining++;
        }
      }
      if (groupRemaining === 0) {
        if (currentPlayer === 'p1') {
          this.state.p1Target = '8 BALL';
        } else {
          this.state.p2Target = '8 BALL';
        }
      }
    }

    return result;
  }

  updateGameState(rulesResult) {
    // Update turn
    if (rulesResult.turnOver && !rulesResult.winner) {
      this.state.turn = this.state.turn === 'p1' ? 'p2' : 'p1';
    }

    // Update ball in hand
    this.state.ballInHand = rulesResult.ballInHand;

    // Update winner
    if (rulesResult.winner) {
      this.state.winner = rulesResult.winner;
      this.state.gameOver = true;
      
      if (rulesResult.winner === 'p1') {
        this.state.p1Score++;
      } else {
        this.state.p2Score++;
      }
    }
  }

  generateShotResult(rulesResult, startTime) {
    // Generate state hash for verification
    const stateHash = this.generateStateHash();

    return {
      shotNumber: this.state.shotNumber,
      balls: this.balls.map(b => b.getState()),
      pocketed: rulesResult.pocketed,
      cueBallPocketed: rulesResult.cueBallPocketed,
      firstContact: rulesResult.firstContact,
      cushionHits: rulesResult.cushionHits,
      fouls: rulesResult.fouls,
      nextTurn: this.state.turn,
      p1Target: this.state.p1Target,
      p2Target: this.state.p2Target,
      ballInHand: this.state.ballInHand,
      winner: this.state.winner,
      gameOver: this.state.gameOver,
      p1Score: this.state.p1Score,
      p2Score: this.state.p2Score,
      stateHash: stateHash,
      executionTime: Date.now() - startTime,
      frames: rulesResult.frames,
      snapshots: rulesResult.snapshots,
      frameStride: rulesResult.frameStride,
      frameTimeMs: rulesResult.frameTimeMs,
      timestamp: Date.now()
    };
  }

  generateStateHash() {
    const stateData = {
      shotNumber: this.state.shotNumber,
      balls: this.balls.map(b => ({
        id: b.id,
        active: b.active,
        pos: { x: Math.round(b.position.x), y: Math.round(b.position.y) }
      })),
      turn: this.state.turn,
      targets: {
        p1: this.state.p1Target,
        p2: this.state.p2Target
      }
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(stateData))
      .digest('hex');
  }

  getGameState() {
    return {
      ...this.state,
      balls: this.balls.map(b => b.getState())
    };
  }
}

module.exports = ServerGameManager;
