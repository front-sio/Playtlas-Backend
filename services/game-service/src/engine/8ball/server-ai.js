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

// AI difficulty profiles (enhanced for season play)
const AI_PROFILES = {
  1: { // Easy
    name: 'Easy',
    errorDegrees: 12,
    powerVariance: 0.25,
    missChance: 0.25,
    thinkTime: 2500,
    safetyPlayChance: 0.08,
    trialsPerShot: 10
  },
  2: { // Medium-Easy  
    name: 'Medium-Easy',
    errorDegrees: 8,
    powerVariance: 0.20,
    missChance: 0.18,
    thinkTime: 2200,
    safetyPlayChance: 0.12,
    trialsPerShot: 12
  },
  3: { // Medium
    name: 'Medium',
    errorDegrees: 6,
    powerVariance: 0.15,
    missChance: 0.12,
    thinkTime: 2000,
    safetyPlayChance: 0.15,
    trialsPerShot: 15
  },
  4: { // Medium-Hard
    name: 'Medium-Hard',
    errorDegrees: 4,
    powerVariance: 0.12,
    missChance: 0.08,
    thinkTime: 1800,
    safetyPlayChance: 0.18,
    trialsPerShot: 18
  },
  5: { // Hard
    name: 'Hard',
    errorDegrees: 3,
    powerVariance: 0.10,
    missChance: 0.06,
    thinkTime: 1500,
    safetyPlayChance: 0.22,
    trialsPerShot: 22
  }
};

const AI_PROFILE_RANGE = {
  errorDegrees: { min: 0.5, max: 12 }, // Much more precise at high levels
  powerVariance: { min: 0.02, max: 0.25 }, 
  missChance: { min: 0.001, max: 0.25 }, // Nearly perfect at top levels
  thinkTime: { min: 800, max: 2500 },
  safetyPlayChance: { min: 0.05, max: 0.35 }, // More strategic at higher levels
  trialsPerShot: { min: 8, max: 100 } // Much more calculation power
};

function lerp(min, max, t) {
  return min + (max - min) * t;
}

function getProfileForLevel(level) {
  const clamped = Math.max(1, Math.min(100, Math.round(level || 8))); // Cap at level 100, default to level 8
  if (clamped <= 5) {
    return AI_PROFILES[clamped];
  }
  
  // Advanced difficulty curve for levels 6-100 with much more precision
  const t = Math.pow((clamped - 1) / 99, 0.6); // More gradual progression curve for 100 levels
  
  return {
    name: `Level ${clamped}`,
    errorDegrees: lerp(AI_PROFILE_RANGE.errorDegrees.max, AI_PROFILE_RANGE.errorDegrees.min, t),
    powerVariance: lerp(AI_PROFILE_RANGE.powerVariance.max, AI_PROFILE_RANGE.powerVariance.min, t),
    missChance: lerp(AI_PROFILE_RANGE.missChance.max, AI_PROFILE_RANGE.missChance.min, t),
    thinkTime: Math.round(lerp(AI_PROFILE_RANGE.thinkTime.max, AI_PROFILE_RANGE.thinkTime.min, t)),
    safetyPlayChance: lerp(AI_PROFILE_RANGE.safetyPlayChance.min, AI_PROFILE_RANGE.safetyPlayChance.max, t),
    trialsPerShot: Math.round(lerp(AI_PROFILE_RANGE.trialsPerShot.min, AI_PROFILE_RANGE.trialsPerShot.max, t))
  };
}

class PoolAI {
  constructor(difficulty = 8, tableGeometry) { // Default to level 8 for competitive play
    this.difficulty = Math.max(1, Math.min(100, difficulty)); // Cap at level 100
    this.profile = getProfileForLevel(this.difficulty);
    this.table = tableGeometry;
    this.ballRadius = tableGeometry.ballRadius;
    this.strategicMemory = []; // Remember previous shots for strategy
    this.gameAnalysis = { // Advanced game state analysis
      preferredTargets: [],
      dangerousShots: [],
      safetyPositions: []
    };
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

    // Enhanced shot selection with strategic considerations
    shotOptions.forEach(shot => {
      // Add strategic bonuses
      if (shot.type === 'direct') {
        shot.score += 20; // Prefer direct shots
      }
      
      // Bonus for easier target positions
      if (shot.difficulty < 30) {
        shot.score += 15;
      }
      
      // Penalty for very risky shots at lower difficulties
      if (this.difficulty < 50 && shot.difficulty > 70) {
        shot.score -= 25;
      }
      
      // High difficulty AI prefers precise shots
      if (this.difficulty > 75 && shot.difficulty > 60) {
        shot.score += 10; // Advanced AI can handle difficult shots
      }
    });

    // Sort by enhanced score
    shotOptions.sort((a, b) => b.score - a.score);

    // Smart selection based on difficulty
    let selectionRange;
    if (this.difficulty >= 80) {
      selectionRange = 1; // Expert AI picks best shot
    } else if (this.difficulty >= 50) {
      selectionRange = Math.min(2, shotOptions.length); // Pick from top 2
    } else if (this.difficulty >= 20) {
      selectionRange = Math.min(3, shotOptions.length); // Pick from top 3
    } else {
      selectionRange = Math.min(5, shotOptions.length); // Beginner picks from top 5
    }
    
    const selectedIndex = Math.floor(Math.random() * selectionRange);
    const selectedShot = shotOptions[selectedIndex];
    
    // Store strategic memory
    this.strategicMemory.push({
      difficulty: selectedShot.difficulty,
      score: selectedShot.score,
      type: selectedShot.type
    });
    
    // Keep only recent memory
    if (this.strategicMemory.length > 10) {
      this.strategicMemory.shift();
    }
    
    return selectedShot;
  }

  applyAiError(shot) {
    if (!shot) return shot;

    // Reduced error application for competitive play
    const skillFactor = Math.min(this.difficulty / 100, 0.95); // Cap at 95% skill
    
    // Apply direction error with intelligence scaling
    const baseErrorRadians = (this.profile.errorDegrees * (Math.PI / 180)) * (Math.random() - 0.5);
    const intelligenceReduction = skillFactor * 0.7; // High skill reduces error significantly
    const errorRadians = baseErrorRadians * (1 - intelligenceReduction);
    
    const currentAngle = Math.atan2(shot.direction.y, shot.direction.x);
    const newAngle = currentAngle + errorRadians;
    
    shot.direction = {
      x: Math.cos(newAngle),
      y: Math.sin(newAngle)
    };

    // Intelligent power variance
    const powerError = 1 + (Math.random() - 0.5) * this.profile.powerVariance * (1 - skillFactor * 0.5);
    shot.power = Math.min(Math.max(shot.power * powerError, 500), 6000);

    // Smart miss probability - high skill AI rarely misses intentionally
    const adjustedMissChance = this.profile.missChance * (1 - skillFactor * 0.8);
    if (Math.random() < adjustedMissChance) {
      // Intelligent miss - still strategic, not random
      const strategicMissError = (Math.random() - 0.5) * 15 * (Math.PI / 180) * (1 - skillFactor);
      const missAngle = newAngle + strategicMissError;
      shot.direction = {
        x: Math.cos(missAngle),
        y: Math.sin(missAngle)
      };
    }

    // Advanced AI can use spin for better control
    if (this.difficulty > 60) {
      shot.screw = (Math.random() - 0.5) * 0.3 * skillFactor; // Slight backspin for control
      shot.english = (Math.random() - 0.5) * 0.2 * skillFactor; // Minimal side spin
    } else {
      shot.screw = 0;
      shot.english = 0;
    }

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
