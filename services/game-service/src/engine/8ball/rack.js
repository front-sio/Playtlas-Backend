// backend/services/game-service/src/engine/8ball/rack.js
const { Point } = require('./maths');

function setBallPositions({ adjustmentScale, ballRadius, rng }) {
  const positions = [];
  const base = 15000 * adjustmentScale;
  const randOffset = 0.05 + 0.05 * rng.next();
  const spread = 1 + (0.05 + 0.05 * rng.next());
  const e = 1.732 + randOffset;

  positions[0] = new Point(-base, 0);
  positions[1] = new Point(base, 0);
  positions[2] = new Point(base + e * ballRadius, ballRadius * spread);
  positions[15] = new Point(base + e * ballRadius, -ballRadius * spread);
  positions[8] = new Point(base + 2 * e * ballRadius, 0);
  positions[5] = new Point(base + 2 * e * ballRadius, 2 * ballRadius * spread);
  positions[10] = new Point(base + 2 * e * ballRadius, -2 * ballRadius * spread);
  positions[7] = new Point(base + 3 * e * ballRadius, ballRadius * spread);
  positions[4] = new Point(base + 3 * e * ballRadius, 3 * ballRadius * spread);
  positions[9] = new Point(base + 3 * e * ballRadius, -ballRadius * spread);
  positions[6] = new Point(base + 3 * e * ballRadius, -3 * ballRadius * spread);
  positions[11] = new Point(base + 4 * e * ballRadius, 0);
  positions[12] = new Point(base + 4 * e * ballRadius, 2 * ballRadius * spread);
  positions[13] = new Point(base + 4 * e * ballRadius, -2 * ballRadius * spread);
  positions[14] = new Point(base + 4 * e * ballRadius, 4 * ballRadius * spread);
  positions[3] = new Point(base + 4 * e * ballRadius, -4 * ballRadius * spread);

  return positions;
}

module.exports = { setBallPositions };
