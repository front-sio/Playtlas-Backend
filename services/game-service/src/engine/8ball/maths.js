const Maths = function () {};

const Point = function (x, y) {
  this.x = x;
  this.y = y;
};

Point.interpolate = function (a, b, n) {
  const x = Maths.fixNumber((1 - n) * a.x + n * b.x);
  const y = Maths.fixNumber((1 - n) * a.y + n * b.y);
  return new Point(x, y);
};

Point.prototype.equals = function (other) {
  return this.x === other.x && this.y === other.y;
};

Maths.lineIntersectLine = function (a, b, c, d, enforceSegments = true) {
  const A = b.y - a.y;
  const B = a.x - b.x;
  const C = b.x * a.y - a.x * b.y;
  const D = d.y - c.y;
  const E = c.x - d.x;
  const F = d.x * c.y - c.x * d.y;
  const denom = A * E - D * B;

  if (denom === 0) return null;

  const x = Maths.fixNumber((B * F - E * C) / denom);
  const y = Maths.fixNumber((D * C - A * F) / denom);
  const point = new Point(x, y);

  if (enforceSegments) {
    if (
      (point.x - a.x) * (point.x - b.x) > 0 ||
      (point.y - a.y) * (point.y - b.y) > 0 ||
      (point.x - c.x) * (point.x - d.x) > 0 ||
      (point.y - c.y) * (point.y - d.y) > 0
    ) {
      return null;
    }
  }

  return point;
};

Maths.lineIntersectCircle = function (a, b, center, radius) {
  const result = {
    inside: false,
    tangent: false,
    intersects: false,
    enter: null,
    exit: null,
  };

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - center.x;
  const fy = a.y - center.y;

  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - radius * radius;
  const discriminant = Maths.fixNumber(B * B - 4 * A * C);

  if (discriminant <= 0) return result;

  const sqrtDisc = Maths.fixNumber(Math.sqrt(discriminant));
  const t1 = Maths.fixNumber((-B - sqrtDisc) / (2 * A));
  const t2 = Maths.fixNumber((-B + sqrtDisc) / (2 * A));

  if ((t1 < 0 || t1 > 1) && (t2 < 0 || t2 > 1)) {
    result.inside = !(t1 < 0 && t2 < 0 || t1 > 1 && t2 > 1);
    return result;
  }

  if (t1 >= 0 && t1 <= 1) {
    result.enter = Point.interpolate(a, b, t1);
    result.enter = new Point(Maths.fixNumber(result.enter.x), Maths.fixNumber(result.enter.y));
    result.intersects = true;
  }

  if (t2 >= 0 && t2 <= 1) {
    result.exit = Point.interpolate(a, b, t2);
    result.exit = new Point(Maths.fixNumber(result.exit.x), Maths.fixNumber(result.exit.y));
    result.intersects = true;
  }

  if (result.exit && result.enter && result.exit.equals(result.enter)) {
    result.tangent = true;
  }

  return result;
};

Maths.findBearing = function (x, y) {
  return Maths.fixNumber((180 / Math.PI) * Math.atan2(y, x));
};

Maths.angleDiff = function (a, b) {
  const diff = Maths.wrapValue(a + 180 - b) - 180;
  return Maths.fixNumber(diff);
};

Maths.wrapValue = function (value) {
  let v = value;
  if (v > 360) v -= 360;
  if (v < 0) v += 360;
  return v;
};

Maths.fixNumber = function (value) {
  if (Number.isNaN(Number(value))) return 0;
  return Math.round(Number(value) * 10000) / 10000;
};

Maths.createVectorFrom2Points = function (a, b) {
  const Vector2D = require('./vector2d');
  return new Vector2D(b.x - a.x, b.y - a.y);
};

Maths.checkObjectsConverging = function (a, b, v1, v2) {
  const Vector2D = require('./vector2d');
  const relative = v2.minus(v1);
  const dir = b.minus(a).normalize();
  return relative.angleBetween(dir) > 90;
};

module.exports = { Maths, Point };
