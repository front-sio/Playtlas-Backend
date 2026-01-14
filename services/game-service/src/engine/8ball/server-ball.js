// backend/services/game-service/src/engine/8ball/server-ball.js
/**
 * Server-side Ball Entity - Ported from Phaser.js
 * Represents a pool ball with position, velocity, spin mechanics
 */

const Vector2D = require('./server-vector2d');

class Ball {
  constructor(id, position, ballRadius) {
    this.id = id;
    this.position = new Vector2D(position.x, position.y);
    this.velocity = new Vector2D(0, 0);
    this.active = 1;
    this.ballRadius = ballRadius;
    
    // Ball type classification
    if (id === 0) {
      this.targetType = 'CUE';
    } else if (id > 0 && id < 8) {
      this.targetType = 'SOLIDS';
    } else if (id > 8) {
      this.targetType = 'STRIPES';
    } else if (id === 8) {
      this.targetType = '8 BALL';
    } else {
      this.targetType = 'ANY';
    }
    
    // Collision tracking
    this.contactArray = [];
    this.firstContact = false;
    this.lastCollisionObject = null;
    this.lastVertex = null;
    
    // Advanced spin mechanics
    this.screw = 0;       // Bottom/top spin (-1 to 1)
    this.english = 0;     // Left/right spin (-1 to 1)
    this.ySpin = 0;       // Side spin from cushion hits
    this.deltaScrew = new Vector2D(0, 0);  // Screw effect vector
    this.grip = 1;        // 0-1, how much ball grips cloth
  }

  // Check if ball is moving
  isMoving() {
    return this.velocity.magnitudeSquared > 0;
  }

  // Get ball state for serialization
  getState() {
    return {
      id: this.id,
      position: { x: this.position.x, y: this.position.y },
      velocity: { x: this.velocity.x, y: this.velocity.y },
      active: this.active,
      targetType: this.targetType,
      screw: this.screw,
      english: this.english,
      ySpin: this.ySpin
    };
  }

  // Restore ball state
  setState(state) {
    this.position.x = state.position.x;
    this.position.y = state.position.y;
    this.velocity.x = state.velocity.x;
    this.velocity.y = state.velocity.y;
    this.active = state.active;
    if (state.screw !== undefined) this.screw = state.screw;
    if (state.english !== undefined) this.english = state.english;
    if (state.ySpin !== undefined) this.ySpin = state.ySpin;
  }

  // Reset for new shot
  reset() {
    this.contactArray = [];
    this.firstContact = false;
    this.lastCollisionObject = null;
    this.lastVertex = null;
    this.deltaScrew = new Vector2D(0, 0);
    this.grip = 1;
  }
}

module.exports = Ball;
