// backend/services/game-service/src/engine/8ball/server-ai.js
/**
 * AUTHORITATIVE SERVER-SIDE AI ENGINE
 * Ported from frontend/public/8ball-match-withai/assets/src/15gameController.js
 * 
 * AI calculates shots ON SERVER - client cannot manipulate AI decisions
 * Supports 5 difficulty levels for fair gameplay
 */

const Vector2D = require('./server-vector2d');
const { Maths, Point } = require('./server-maths');
const logger = require('../../utils/logger');

// AI difficulty profiles
const AI_PROFILES = {
  1: { // Easy
    name: 'Easy',
    errorDegrees: 15,
    powerVariance: 0.25,
    missChance: 0.30,
    thinkTime: 2000,
    safetyPlayChance: 0.05,
    trialsPerShot: 10
  },
  2: { // Medium
    name: 'Medium',
    errorDegrees: 8,
    powerVariance: 0.15,
    missChance: 0.15,
    thinkTime: 1500,
    safetyPlayChance: 0.15,
    trialsPerShot: 15
  },
  3: { // Hard
    name: 'Hard',
    errorDegrees: 4,
    powerVariance: 0.10,
    missChance: 0.08,
    thinkTime: 1200,
    safetyPlayChance: 0.25,
    trialsPerShot: 20
  },
  4: { // Expert
    name: 'Expert',
    errorDegrees: 2,
    powerVariance: 0.05,
    missChance: 0.03,
    thinkTime: 1000,
    safetyPlayChance: 0.35,
    trialsPerShot: 25
  },
  5: { // Master
    name: 'Master',
    errorDegrees: 1,
    powerVariance: 0.03,
    missChance: 0.01,
    thinkTime: 800,
    safetyPlayChance: 0.45,
    trialsPerShot: 30
  }
};

class PoolAI {
  constructor(difficulty = 3, tableGeometry) {
    this.difficulty = Math.max(1, Math.min(5, difficulty));
    this.profile = AI_PROFILES[this.difficulty];
    this.table = tableGeometry;
    this.ballRadius = tableGeometry.ballRadius;
  }

  /**
   * Calculate best shot for AI
   * Returns: { direction: {x, y}, power: number, cueBallPosition?: {x, y}, screw?: number, english?: number }
   */
  async calculateShot(gameState) {
    const startTime = Date.now();
    
    // Get AI's target balls
    const targetBalls = this.getTargetBalls(gameState);
    
    if (targetBalls.length === 0) {
      logger.warn('[AI] No target balls found, taking random shot');
      return this.calculateRandomShot(gameState);
    }

    // If ball in hand, find best cue ball position
    let cueBallPosition = null;
    if (gameState.ballInHand) {
      cueBallPosition = this.findBestCueBallPosition(gameState, targetBalls);
    }

    // Calculate shot options
    const shotOptions = this.calculateShotOptions(gameState, targetBalls, cueBallPosition);
    
    if (shotOptions.length === 0) {
      logger.warn('[AI] No valid shots found, taking random shot');
      return this.calculateRandomShot(gameState);
    }

    // Select best shot based on difficulty
    const bestShot = this.selectBestShot(shotOptions);
    
    // Apply difficulty-based error
    const finalShot = this.applyAiError(bestShot);
    
    const elapsedTime = Date.now() - startTime;
    logger.info(`[AI] Calculated shot in ${elapsedTime}ms, difficulty: ${this.profile.name}`);
    
    return finalShot;
  }

  getTargetBalls(gameState) {
    const aiTarget = gameState.p2Target || 'ANY';
    const targetBalls = [];

    for (const ball of gameState.balls) {
      if (!ball.active || ball.id === 0) continue;
      
      if (aiTarget === 'ANY' && ball.targetType !== '8 BALL') {
        targetBalls.push(ball);
      } else if (aiTarget === '8 BALL' && ball.id === 8) {
        targetBalls.push(ball);
      } else if (aiTarget === 'SOLIDS' && ball.targetType === 'SOLIDS') {
        targetBalls.push(ball);
      } else if (aiTarget === 'STRIPES' && ball.targetType === 'STRIPES') {
        targetBalls.push(ball);
      }
    }

    return targetBalls;
  }

  findBestCueBallPosition(gameState, targetBalls) {
    // Try multiple cue ball positions and pick the best
    const candidates = [];
    const bounds = this.table.bounds;
    const margin = this.ballRadius * 3;

    // Add some strategic positions
    candidates.push(new Point(0, 0)); // Center
    candidates.push(new Point(bounds.left + margin, 0)); // Left center
    candidates.push(new Point(bounds.right - margin, 0)); // Right center

    // Add random positions based on difficulty
    const numRandom = Math.floor(this.profile.trialsPerShot / 2);
    for (let i = 0; i < numRandom; i++) {
      const x = bounds.left + margin + Math.random() * (bounds.right - bounds.left - 2 * margin);
      const y = bounds.top + margin + Math.random() * (bounds.bottom - bounds.top - 2 * margin);
      const pos = new Point(x, y);
      
      if (this.isValidCueBallPosition(pos, gameState.balls)) {
        candidates.push(pos);
      }
    }

    // Score each position
    let bestPos = candidates[0];
    let bestScore = -Infinity;

    for (const pos of candidates) {
      if (!this.isValidCueBallPosition(pos, gameState.balls)) continue;
      
      let score = 0;
      
      for (const targetBall of targetBalls) {
        for (const pocket of this.table.pocketArray) {
          const shotScore = this.scorePotentialShot(pos, targetBall, pocket, gameState.balls);
          if (shotScore > score) {
            score = shotScore;
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }

    return { x: bestPos.x, y: bestPos.y };
  }

  isValidCueBallPosition(position, balls) {
    // Check not overlapping with other balls
    for (const ball of balls) {
      if (ball.id === 0 || !ball.active) continue;
      
      const dx = ball.position.x - position.x;
      const dy = ball.position.y - position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < this.ballRadius * 2.2) {
        return false;
      }
    }

    // Check within table bounds
    const bounds = this.table.bounds;
    const margin = this.ballRadius * 1.5;
    
    return position.x > bounds.left + margin &&
           position.x < bounds.right - margin &&
           position.y > bounds.top + margin &&
           position.y < bounds.bottom - margin;
  }

  calculateShotOptions(gameState, targetBalls, cueBallPosition) {
    const shots = [];
    const cueBall = cueBallPosition 
      ? { position: new Vector2D(cueBallPosition.x, cueBallPosition.y) }
      : gameState.balls.find(b => b.id === 0);

    // For each target ball, calculate shots to each pocket
    for (const targetBall of targetBalls) {
      for (const pocket of this.table.pocketArray) {
        const shot = this.calculateShotToPocket(cueBall, targetBall, pocket, gameState.balls);
        
        if (shot) {
          shots.push(shot);
        }
      }
    }

    // Add bank shots for higher difficulties
    if (this.difficulty >= 3) {
      const bankShots = this.calculateBankShots(cueBall, targetBalls, gameState.balls);
      shots.push(...bankShots);
    }

    return shots;
  }

  calculateShotToPocket(cueBall, targetBall, pocket, allBalls) {
    // Calculate where to hit the target ball to pot it
    const pocketPos = pocket.position;
    const targetPos = new Vector2D(targetBall.position.x, targetBall.position.y);
    
    // Direction from target to pocket
    const toPocket = new Vector2D(
      pocketPos.x - targetPos.x,
      pocketPos.y - targetPos.y
    ).normalize();

    // Point on target ball to hit (opposite side of pocket direction)
    const hitPoint = targetPos.minus(toPocket.times(this.ballRadius * 2));

    // Direction from cue ball to hit point
    const cuePos = new Vector2D(cueBall.position.x, cueBall.position.y);
    const direction = hitPoint.minus(cuePos).normalize();
    
    // Check if path is clear
    if (!this.isPathClear(cuePos, hitPoint, allBalls, [0, targetBall.id])) {
      return null;
    }

    // Check if target ball path to pocket is clear
    if (!this.isPathClear(targetPos, new Vector2D(pocketPos.x, pocketPos.y), allBalls, [targetBall.id])) {
      return null;
    }

    // Calculate difficulty score
    const distance = hitPoint.minus(cuePos).magnitude;
    const cutAngle = this.calculateCutAngle(cuePos, targetPos, new Vector2D(pocketPos.x, pocketPos.y));
    
    // Difficulty increases with distance and cut angle
    const difficulty = (distance / 10000) + (cutAngle / 45);
    
    // Calculate power (based on distance)
    const basePower = 500 + Math.min(distance / 10, 4000);
    const power = Math.min(basePower, 5500);

    return {
      direction: { x: direction.x, y: direction.y },
      power: power,
      targetBall: targetBall,
      pocket: pocket,
      difficulty: difficulty,
      score: 100 - difficulty, // Higher score for easier shots
      type: 'direct',
      cueBallPosition: cueBall.position.x !== undefined ? null : { x: cueBall.position.x, y: cueBall.position.y }
    };
  }

  calculateBankShots(cueBall, targetBalls, allBalls) {
    const bankShots = [];
    
    // Calculate one-cushion bank shots
    for (const targetBall of targetBalls) {
      for (const cushion of this.table.lineArray) {
        for (const pocket of this.table.pocketArray) {
          const shot = this.calculateBankShot(cueBall, targetBall, cushion, pocket, allBalls);
          if (shot) {
            bankShots.push(shot);
          }
        }
      }
    }

    return bankShots;
  }

  calculateBankShot(cueBall, targetBall, cushion, pocket, allBalls) {
    // Simplified bank shot calculation
    // Calculate reflection point on cushion
    const targetPos = new Vector2D(targetBall.position.x, targetBall.position.y);
    const pocketPos = new Vector2D(pocket.position.x, pocket.position.y);
    
    // Mirror pocket position across cushion
    const mirrorPos = this.mirrorPointAcrossCushion(pocketPos, cushion);
    
    if (!mirrorPos) return null;

    // Direction to hit target ball toward mirror
    const toMirror = mirrorPos.minus(targetPos).normalize();
    const hitPoint = targetPos.minus(toMirror.times(this.ballRadius * 2));
    
    const cuePos = new Vector2D(cueBall.position.x, cueBall.position.y);
    const direction = hitPoint.minus(cuePos).normalize();
    
    const distance = hitPoint.minus(cuePos).magnitude;
    const power = Math.min(1000 + distance / 8, 5000);

    return {
      direction: { x: direction.x, y: direction.y },
      power: power,
      targetBall: targetBall,
      pocket: pocket,
      difficulty: 80, // Bank shots are harder
      score: 30, // Lower priority than direct shots
      type: 'bank'
    };
  }

  mirrorPointAcrossCushion(point, cushion) {
    // Simple mirroring based on cushion normal
    const normal = cushion.normal;
    const d = 2 * (point.x * normal.x + point.y * normal.y);
    
    return new Vector2D(
      point.x - d * normal.x,
      point.y - d * normal.y
    );
  }

  calculateCutAngle(cuePos, targetPos, pocketPos) {
    // Angle between cue-to-target and target-to-pocket
    const v1 = targetPos.minus(cuePos).normalize();
    const v2 = pocketPos.minus(targetPos).normalize();
    
    const dot = v1.dot(v2);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
    
    return Math.abs(90 - angle); // 0 = straight shot, 90 = perpendicular
  }

  isPathClear(start, end, allBalls, ignoreIds) {
    const lineStart = new Point(start.x, start.y);
    const lineEnd = new Point(end.x, end.y);
    
    for (const ball of allBalls) {
      if (ignoreIds.includes(ball.id) || !ball.active) continue;
      
      const ballPos = new Point(ball.position.x, ball.position.y);
      const intersection = Maths.lineIntersectCircle(lineStart, lineEnd, ballPos, this.ballRadius * 2);
      
      if (intersection.intersects && !intersection.tangent) {
        return false;
      }
    }
    
    return true;
  }

  scorePotentialShot(cueBallPos, targetBall, pocket, allBalls) {
    // Quick scoring without full calculation
    const cuePos = new Vector2D(cueBallPos.x, cueBallPos.y);
    const targetPos = new Vector2D(targetBall.position.x, targetBall.position.y);
    const pocketPos = new Vector2D(pocket.position.x, pocket.position.y);
    
    // Distance from cue to target
    const dist1 = cuePos.minus(targetPos).magnitude;
    
    // Distance from target to pocket
    const dist2 = targetPos.minus(pocketPos).magnitude;
    
    // Alignment score (how straight is the shot)
    const v1 = targetPos.minus(cuePos).normalize();
    const v2 = pocketPos.minus(targetPos).normalize();
    const alignment = v1.dot(v2);
    
    // Lower score for longer/harder shots
    const score = alignment * 100 - (dist1 / 1000) - (dist2 / 1000);
    
    return score;
  }

  selectBestShot(shotOptions) {
    if (shotOptions.length === 0) return null;

    // Sort by score (higher is better)
    shotOptions.sort((a, b) => b.score - a.score);

    // Select from top shots based on difficulty
    // Easy AI might pick from top 5, expert from top 1-2
    const selectionRange = Math.max(1, Math.floor(shotOptions.length * (1 - this.difficulty / 6)));
    const selectedIndex = Math.floor(Math.random() * Math.min(selectionRange, shotOptions.length));
    
    return shotOptions[selectedIndex];
  }

  applyAiError(shot) {
    if (!shot) return shot;

    // Apply direction error
    const errorRadians = (this.profile.errorDegrees * (Math.PI / 180)) * (Math.random() - 0.5);
    const currentAngle = Math.atan2(shot.direction.y, shot.direction.x);
    const newAngle = currentAngle + errorRadians;
    
    shot.direction = {
      x: Math.cos(newAngle),
      y: Math.sin(newAngle)
    };

    // Apply power variance
    const powerError = 1 + (Math.random() - 0.5) * this.profile.powerVariance;
    shot.power = Math.min(Math.max(shot.power * powerError, 500), 6000);

    // Random miss chance
    if (Math.random() < this.profile.missChance) {
      // Intentional miss - add more error
      const missError = (Math.random() - 0.5) * 30 * (Math.PI / 180);
      const missAngle = newAngle + missError;
      shot.direction = {
        x: Math.cos(missAngle),
        y: Math.sin(missAngle)
      };
    }

    // Usually no spin for AI (can add for higher difficulty)
    shot.screw = 0;
    shot.english = 0;

    return shot;
  }

  calculateRandomShot(gameState) {
    // Fallback: shoot at any active ball
    const cueBall = gameState.balls.find(b => b.id === 0);
    const activeBalls = gameState.balls.filter(b => b.active && b.id !== 0);
    
    if (activeBalls.length === 0) {
      // No balls? Shoot straight
      return {
        direction: { x: 1, y: 0 },
        power: 3000,
        screw: 0,
        english: 0
      };
    }

    const targetBall = activeBalls[Math.floor(Math.random() * activeBalls.length)];
    const cuePos = new Vector2D(cueBall.position.x, cueBall.position.y);
    const targetPos = new Vector2D(targetBall.position.x, targetBall.position.y);
    
    const direction = targetPos.minus(cuePos).normalize();
    const distance = targetPos.minus(cuePos).magnitude;
    
    // Apply error
    const errorRadians = (Math.random() - 0.5) * 30 * (Math.PI / 180);
    const angle = Math.atan2(direction.y, direction.x) + errorRadians;
    
    return {
      direction: {
        x: Math.cos(angle),
        y: Math.sin(angle)
      },
      power: Math.min(1000 + distance / 10, 4500),
      screw: 0,
      english: 0
    };
  }

  getThinkTime() {
    // Add some randomness to think time
    const variance = 500;
    return this.profile.thinkTime + (Math.random() - 0.5) * variance;
  }
}

module.exports = PoolAI;
