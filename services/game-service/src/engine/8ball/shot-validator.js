// backend/services/game-service/src/engine/8ball/shot-validator.js
/**
 * AUTHORITATIVE SHOT VALIDATOR
 * Prevents cheating by validating all shot inputs before physics execution
 */

const logger = require('../../utils/logger');

class ShotValidator {
  constructor() {
    this.recentShots = new Map(); // Track shot timing per match
  }

  /**
   * Validate shot parameters before execution
   * Returns: { valid: boolean, error?: string }
   */
  async validateShot(matchState, shotData, playerId) {
    // 1. Check if it's player's turn
    if (matchState.turn !== playerId) {
      return {
        valid: false,
        error: 'NOT_YOUR_TURN',
        message: 'It is not your turn'
      };
    }

    // 2. Check if game is still active
    if (matchState.winner) {
      return {
        valid: false,
        error: 'GAME_OVER',
        message: 'Game has already ended'
      };
    }

    // 3. Validate power range
    const MIN_POWER = 0;
    const MAX_POWER = 6000;
    if (shotData.power < MIN_POWER || shotData.power > MAX_POWER) {
      return {
        valid: false,
        error: 'INVALID_POWER',
        message: `Power must be between ${MIN_POWER} and ${MAX_POWER}`
      };
    }

    // 4. Validate direction vector
    if (!shotData.direction || typeof shotData.direction.x !== 'number' || typeof shotData.direction.y !== 'number') {
      return {
        valid: false,
        error: 'INVALID_DIRECTION',
        message: 'Direction must be a valid vector'
      };
    }

    const dirMag = Math.sqrt(shotData.direction.x ** 2 + shotData.direction.y ** 2);
    if (dirMag < 0.9 || dirMag > 1.1) {
      return {
        valid: false,
        error: 'INVALID_DIRECTION',
        message: 'Direction must be a normalized vector'
      };
    }

    // 5. Validate spin parameters (if provided)
    if (shotData.screw !== undefined) {
      if (shotData.screw < -1 || shotData.screw > 1) {
        return {
          valid: false,
          error: 'INVALID_SCREW',
          message: 'Screw must be between -1 and 1'
        };
      }
    }

    if (shotData.english !== undefined) {
      if (shotData.english < -1 || shotData.english > 1) {
        return {
          valid: false,
          error: 'INVALID_ENGLISH',
          message: 'English must be between -1 and 1'
        };
      }
    }

    // 6. Validate cue ball position (if ball in hand)
    if (matchState.ballInHand) {
      if (!shotData.cueBallPosition) {
        return {
          valid: false,
          error: 'MISSING_CUE_POSITION',
          message: 'Cue ball position required when ball in hand'
        };
      }

      // Check cue ball position is within valid area
      const validArea = this.getValidCueBallArea(matchState);
      if (!this.isPositionInArea(shotData.cueBallPosition, validArea)) {
        return {
          valid: false,
          error: 'INVALID_CUE_POSITION',
          message: 'Cue ball position not in valid area'
        };
      }

      // Check cue ball doesn't overlap with other balls
      const overlaps = this.checkBallOverlap(shotData.cueBallPosition, matchState.balls);
      if (overlaps) {
        return {
          valid: false,
          error: 'CUE_BALL_OVERLAP',
          message: 'Cue ball position overlaps with another ball'
        };
      }
    } else {
      // If not ball in hand, cue ball position should match current position
      const cueBall = matchState.balls.find(b => b.id === 0);
      if (shotData.cueBallPosition) {
        const dist = Math.sqrt(
          (shotData.cueBallPosition.x - cueBall.position.x) ** 2 +
          (shotData.cueBallPosition.y - cueBall.position.y) ** 2
        );
        if (dist > 100) { // Allow small tolerance for floating point
          return {
            valid: false,
            error: 'CUE_POSITION_MISMATCH',
            message: 'Cue ball position does not match current state'
          };
        }
      }
    }

    // 7. Rate limiting - prevent shot spamming
    const rateLimitResult = this.checkRateLimit(matchState.matchId, playerId);
    if (!rateLimitResult.valid) {
      return rateLimitResult;
    }

    // 8. Check for impossible physics (optional advanced check)
    if (this.detectImpossibleShot(shotData, matchState)) {
      logger.warn('[ShotValidator] Potential impossible shot detected', {
        matchId: matchState.matchId,
        playerId,
        shotData
      });
      // Don't reject, but log for analysis
    }

    return { valid: true };
  }

  getValidCueBallArea(matchState) {
    // For 8-ball: after scratch, ball in hand anywhere on table
    // After break scratch: behind head string (kitchen)
    if (matchState.shotNumber === 0 || matchState.scratchOnBreak) {
      // Kitchen area (left third of table)
      return {
        left: -30000 * 2.3,
        right: -15000 * 2.3,
        top: -15000 * 2.3,
        bottom: 15000 * 2.3
      };
    }
    
    // Full table
    return {
      left: -30000 * 2.3,
      right: 30000 * 2.3,
      top: -15000 * 2.3,
      bottom: 15000 * 2.3
    };
  }

  isPositionInArea(position, area) {
    const BALL_RADIUS = 2300;
    return position.x >= area.left + BALL_RADIUS &&
           position.x <= area.right - BALL_RADIUS &&
           position.y >= area.top + BALL_RADIUS &&
           position.y <= area.bottom - BALL_RADIUS;
  }

  checkBallOverlap(position, balls) {
    const BALL_RADIUS = 2300;
    const MIN_DISTANCE = BALL_RADIUS * 2;

    for (const ball of balls) {
      if (ball.id === 0 || !ball.active) continue;
      
      const dist = Math.sqrt(
        (position.x - ball.position.x) ** 2 +
        (position.y - ball.position.y) ** 2
      );

      if (dist < MIN_DISTANCE * 1.05) { // 5% tolerance
        return true;
      }
    }

    return false;
  }

  checkRateLimit(matchId, playerId) {
    const key = `${matchId}:${playerId}`;
    const now = Date.now();
    const lastShot = this.recentShots.get(key);

    const MIN_SHOT_INTERVAL = 500; // 500ms minimum between shots

    if (lastShot && now - lastShot < MIN_SHOT_INTERVAL) {
      return {
        valid: false,
        error: 'RATE_LIMIT',
        message: 'Please wait before shooting again'
      };
    }

    this.recentShots.set(key, now);

    // Clean up old entries (older than 5 minutes)
    if (this.recentShots.size > 1000) {
      for (const [k, v] of this.recentShots.entries()) {
        if (now - v > 300000) {
          this.recentShots.delete(k);
        }
      }
    }

    return { valid: true };
  }

  detectImpossibleShot(shotData, matchState) {
    // Check for physically impossible parameters
    // e.g., max power with max english and max screw simultaneously
    // (would be suspicious but not necessarily impossible)
    
    const suspicionScore = 0;
    
    if (shotData.power > 5500 && 
        Math.abs(shotData.english || 0) > 0.8 && 
        Math.abs(shotData.screw || 0) > 0.8) {
      // Extremely powerful shot with max spin - suspicious but possible
      return true;
    }

    return false;
  }

  // Clear rate limit for a specific match (e.g., when match ends)
  clearMatchRateLimit(matchId) {
    for (const key of this.recentShots.keys()) {
      if (key.startsWith(matchId + ':')) {
        this.recentShots.delete(key);
      }
    }
  }
}

module.exports = ShotValidator;
