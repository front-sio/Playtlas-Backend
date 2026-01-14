// backend/services/game-service/src/engine/8ball/server-table.js
/**
 * Server-side Table Geometry - Ported from levelData.js
 * Defines table boundaries, cushions, pockets
 */

const { Point } = require('./server-maths');

// Table configuration matching client
const TABLE_CONFIG = {
  width: 60000,  // Physics units (adjustmentScale * 30000)
  height: 30000,
  ballRadius: 2300,
  pocketRadius: 2250,
  adjustmentScale: 2.3,
  friction: 1.5,
  minVelocity: 2,
  cushionRestitution: 0.6,
  ballRestitution: 0.94,
  maxPower: 6000
};

class TableGeometry {
  constructor(config = {}) {
    this.config = { ...TABLE_CONFIG, ...config };
    this.ballRadius = this.config.ballRadius;
    
    // Calculate table boundaries
    const halfWidth = 30000 * this.config.adjustmentScale;
    const halfHeight = 15000 * this.config.adjustmentScale;
    
    this.bounds = {
      left: -halfWidth,
      right: halfWidth,
      top: -halfHeight,
      bottom: halfHeight
    };
    
    this.setupCushions();
    this.setupPockets();
  }

  setupCushions() {
    const { left, right, top, bottom } = this.bounds;
    const margin = this.ballRadius;
    
    // Define cushion lines (table rails)
    this.lineArray = [
      {
        name: 'top',
        p3: new Point(left + margin, top + margin),
        p4: new Point(right - margin, top + margin),
        p5: new Point(left + margin, top + margin - 200),
        p6: new Point(right - margin, top + margin - 200),
        normal: new Vector2D(0, 1),
        direction: new Vector2D(1, 0)
      },
      {
        name: 'bottom',
        p3: new Point(left + margin, bottom - margin),
        p4: new Point(right - margin, bottom - margin),
        p5: new Point(left + margin, bottom - margin + 200),
        p6: new Point(right - margin, bottom - margin + 200),
        normal: new Vector2D(0, -1),
        direction: new Vector2D(1, 0)
      },
      {
        name: 'left',
        p3: new Point(left + margin, top + margin),
        p4: new Point(left + margin, bottom - margin),
        p5: new Point(left + margin - 200, top + margin),
        p6: new Point(left + margin - 200, bottom - margin),
        normal: new Vector2D(1, 0),
        direction: new Vector2D(0, 1)
      },
      {
        name: 'right',
        p3: new Point(right - margin, top + margin),
        p4: new Point(right - margin, bottom - margin),
        p5: new Point(right - margin + 200, top + margin),
        p6: new Point(right - margin + 200, bottom - margin),
        normal: new Vector2D(-1, 0),
        direction: new Vector2D(0, 1)
      }
    ];
  }

  setupPockets() {
    const { left, right, top, bottom } = this.bounds;
    const pocketOffset = this.ballRadius * 0.5;
    
    // Six pockets: 4 corners + 2 side pockets
    this.pocketArray = [
      { name: 'top-left', position: new Point(left - pocketOffset, top - pocketOffset), radius: this.config.pocketRadius },
      { name: 'top-center', position: new Point(0, top - pocketOffset), radius: this.config.pocketRadius },
      { name: 'top-right', position: new Point(right + pocketOffset, top - pocketOffset), radius: this.config.pocketRadius },
      { name: 'bottom-left', position: new Point(left - pocketOffset, bottom + pocketOffset), radius: this.config.pocketRadius },
      { name: 'bottom-center', position: new Point(0, bottom + pocketOffset), radius: this.config.pocketRadius },
      { name: 'bottom-right', position: new Point(right + pocketOffset, bottom + pocketOffset), radius: this.config.pocketRadius }
    ];
  }

  // Setup vertex points (pocket edges/corners)
  setupVertices() {
    const { left, right, top, bottom } = this.bounds;
    const margin = this.ballRadius;
    
    this.vertexArray = [
      { name: 'top-left-corner', position: new Point(left + margin, top + margin) },
      { name: 'top-right-corner', position: new Point(right - margin, top + margin) },
      { name: 'bottom-left-corner', position: new Point(left + margin, bottom - margin) },
      { name: 'bottom-right-corner', position: new Point(right - margin, bottom - margin) }
    ];
  }

  // Get standard 8-ball rack positions
  getRackPositions() {
    const positions = new Array(16);
    const startX = 15000 * this.config.adjustmentScale;
    const spacing = 1.732 * this.ballRadius; // Triangular spacing
    const rowSpacing = this.ballRadius * 2;
    
    // Cue ball
    positions[0] = new Point(-startX, 0);
    
    // Standard 8-ball rack (triangle)
    positions[1] = new Point(startX, 0);
    positions[2] = new Point(startX + spacing, rowSpacing);
    positions[15] = new Point(startX + spacing, -rowSpacing);
    positions[8] = new Point(startX + 2 * spacing, 0);
    positions[5] = new Point(startX + 2 * spacing, 2 * rowSpacing);
    positions[10] = new Point(startX + 2 * spacing, -2 * rowSpacing);
    positions[7] = new Point(startX + 3 * spacing, rowSpacing);
    positions[4] = new Point(startX + 3 * spacing, 3 * rowSpacing);
    positions[9] = new Point(startX + 3 * spacing, -rowSpacing);
    positions[6] = new Point(startX + 3 * spacing, -3 * rowSpacing);
    positions[11] = new Point(startX + 4 * spacing, 0);
    positions[12] = new Point(startX + 4 * spacing, 2 * rowSpacing);
    positions[13] = new Point(startX + 4 * spacing, -2 * rowSpacing);
    positions[14] = new Point(startX + 4 * spacing, 4 * rowSpacing);
    positions[3] = new Point(startX + 4 * spacing, -4 * rowSpacing);
    
    return positions;
  }

  // Check if position is valid for cue ball placement
  isValidCueBallPosition(position, otherBalls) {
    // Check table bounds
    if (position.x < this.bounds.left + this.ballRadius ||
        position.x > this.bounds.right - this.ballRadius ||
        position.y < this.bounds.top + this.ballRadius ||
        position.y > this.bounds.bottom - this.ballRadius) {
      return false;
    }
    
    // Check not overlapping with other balls
    for (const ball of otherBalls) {
      if (!ball.active || ball.id === 0) continue;
      const dx = ball.position.x - position.x;
      const dy = ball.position.y - position.y;
      const distSq = dx * dx + dy * dy;
      const minDist = 2 * this.ballRadius;
      if (distSq < minDist * minDist) {
        return false;
      }
    }
    
    return true;
  }
}

const Vector2D = require('./server-vector2d');

module.exports = TableGeometry;
