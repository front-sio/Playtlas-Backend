// backend/services/game-service/src/engine/8ball/table.js
const Vector2D = require('./vector2d');
const { Point } = require('./maths');

function createTableGeometry({ adjustmentScale, ballRadius, pocketRadius }) {
  const pockets = [];
  const vertices = [];
  const lines = [];

  const n = 600 * adjustmentScale;

  const pocket = (x, y, dropX, dropY, starX, starY, id) => ({
    position: new Vector2D(x, y),
    dropPosition: new Vector2D(dropX, dropY),
    starPosition: new Vector2D(starX, starY),
    id,
  });

  pockets.push(pocket(-50 * n - pocketRadius / 2, -25 * n - pocketRadius / 4, -51 * n - pocketRadius / 2, -26 * n - pocketRadius / 4, -50.4 * n - pocketRadius / 2, -25.8 * n - pocketRadius / 4, 0));
  pockets.push(pocket(0 * n, -25 * n - pocketRadius, 0 * n, -25.5 * n - pocketRadius, -0.2 * n, -25.5 * n - pocketRadius, 1));
  pockets.push(pocket(50 * n + pocketRadius / 2, -25 * n - pocketRadius / 4, 51 * n + pocketRadius / 2, -26 * n - pocketRadius / 4, 50 * n + pocketRadius / 2, -26 * n - pocketRadius / 4, 2));
  pockets.push(pocket(-50 * n - pocketRadius / 2, 25 * n + pocketRadius / 4, -51 * n - pocketRadius / 2, 26 * n + pocketRadius / 4, -50.3 * n - pocketRadius / 2, 25.5 * n + pocketRadius / 4, 3));
  pockets.push(pocket(0 * n, 25 * n + pocketRadius, 0 * n, 25.5 * n + pocketRadius, -0.2 * n, 25.3 * n + pocketRadius, 4));
  pockets.push(pocket(50 * n + pocketRadius / 2, 25 * n + pocketRadius / 4, 51 * n + pocketRadius / 2, 26 * n + pocketRadius / 4, 50 * n + pocketRadius / 2, 27 * n - pocketRadius / 4, 5));

  const addLine = (name, p1, p2) => {
    const line = { name, p1, p2 };
    line.direction = new Vector2D(p2.x - p1.x, p2.y - p1.y).normalize();
    line.normal = line.direction.getLeftNormal();
    const offset = line.normal.times(ballRadius);
    const inset = line.normal.times(0.8 * ballRadius);
    line.p3 = p1.plus(offset);
    line.p4 = p2.plus(offset);
    line.p5 = p1.plus(inset);
    line.p6 = p2.plus(inset);
    lines.push(line);
    return line;
  };

  const addVertex = (name, point) => {
    const vertex = { name, position: new Vector2D(point.x, point.y) };
    vertices.push(vertex);
    return vertex;
  };

  let line;

  line = addLine('AB', new Vector2D(-50 * n, -29 * n), new Vector2D(-46 * n, -25 * n));
  addVertex('B', line.p2);
  line = addLine('BC', new Vector2D(-46 * n, -25 * n), new Vector2D(-4 * n, -25 * n));
  addVertex('C', line.p2);
  addLine('CD', new Vector2D(-4 * n, -25 * n), new Vector2D(-2 * n, -29 * n));
  addLine('EF', new Vector2D(2 * n, -29 * n), new Vector2D(4 * n, -25 * n));
  line = addLine('FG', new Vector2D(4 * n, -25 * n), new Vector2D(46 * n, -25 * n));
  addVertex('G', line.p2);
  addLine('GH', new Vector2D(46 * n, -25 * n), new Vector2D(50 * n, -29 * n));
  addLine('IJ', new Vector2D(54 * n, -25 * n), new Vector2D(50 * n, -21 * n));
  line = addLine('JK', new Vector2D(50 * n, -21 * n), new Vector2D(50 * n, 21 * n));
  addVertex('K', line.p2);
  addLine('KL', new Vector2D(50 * n, 21 * n), new Vector2D(54 * n, 25 * n));
  addLine('MN', new Vector2D(50 * n, 29 * n), new Vector2D(46 * n, 25 * n));
  line = addLine('NO', new Vector2D(46 * n, 25 * n), new Vector2D(4 * n, 25 * n));
  addVertex('O', line.p2);
  addLine('OP', new Vector2D(4 * n, 25 * n), new Vector2D(2 * n, 29 * n));
  addLine('QR', new Vector2D(-2 * n, 29 * n), new Vector2D(-4 * n, 25 * n));
  line = addLine('RS', new Vector2D(-4 * n, 25 * n), new Vector2D(-46 * n, 25 * n));
  addVertex('S', line.p2);
  addLine('ST', new Vector2D(-46 * n, 25 * n), new Vector2D(-50 * n, 29 * n));
  addLine('UV', new Vector2D(-54 * n, 25 * n), new Vector2D(-50 * n, 21 * n));
  line = addLine('VW', new Vector2D(-50 * n, 21 * n), new Vector2D(-50 * n, -21 * n));
  addVertex('W', line.p2);
  addLine('WX', new Vector2D(-50 * n, -21 * n), new Vector2D(-54 * n, -25 * n));

  return { pockets, vertices, lines };
}

module.exports = { createTableGeometry };
