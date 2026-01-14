// backend/services/game-service/src/engine/8ball/server-maths.js
/**
 * Server-side Maths utilities - Ported from client Phaser.js game
 * Used for collision detection and geometric calculations
 */

const Vector2D = require('./server-vector2d');

class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  equals(other) {
    return this.x === other.x && this.y === other.y;
  }

  static interpolate(p1, p2, t) {
    const x = Maths.fixNumber((1 - t) * p1.x + t * p2.x);
    const y = Maths.fixNumber((1 - t) * p1.y + t * p2.y);
    return new Point(x, y);
  }
}

class Maths {
  static fixNumber(value) {
    if (isNaN(Number(value))) return 0;
    return Math.round(Number(value) * 10000) / 10000;
  }

  static findBearing(x, y) {
    const angle = (180 / Math.PI) * Math.atan2(y, x);
    return this.fixNumber(angle);
  }

  static angleDiff(angle1, angle2) {
    const diff = this.wrapValue(angle1 + 180 - angle2) - 180;
    return this.fixNumber(diff);
  }

  static wrapValue(angle) {
    while (angle > 360) angle -= 360;
    while (angle < 0) angle += 360;
    return angle;
  }

  static createVectorFrom2Points(p1, p2) {
    return new Vector2D(p2.x - p1.x, p2.y - p1.y);
  }

  static checkObjectsConverging(pos1, pos2, vel1, vel2) {
    const relativeVel = vel2.minus(vel1);
    const direction = pos2.minus(pos1).normalize();
    return relativeVel.angleBetween(direction) > 90;
  }

  static lineIntersectLine(p1, p2, p3, p4) {
    const x1 = p1.x, y1 = p1.y;
    const x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y;
    const x4 = p4.x, y4 = p4.y;

    const a1 = y2 - y1;
    const b1 = x1 - x2;
    const c1 = x2 * y1 - x1 * y2;

    const a2 = y4 - y3;
    const b2 = x3 - x4;
    const c2 = x4 * y3 - x3 * y4;

    const denom = a1 * b2 - a2 * b1;
    if (denom === 0) return null;

    const x = (b1 * c2 - b2 * c1) / denom;
    const y = (a2 * c1 - a1 * c2) / denom;

    const result = new Point(
      this.fixNumber(x),
      this.fixNumber(y)
    );

    // Check if point is on both line segments
    if ((result.x - x1) * (result.x - x2) > 0 ||
        (result.y - y1) * (result.y - y2) > 0 ||
        (result.x - x3) * (result.x - x4) > 0 ||
        (result.y - y3) * (result.y - y4) > 0) {
      return null;
    }

    return result;
  }

  static lineIntersectCircle(lineStart, lineEnd, circleCenter, circleRadius) {
    const result = {
      inside: false,
      tangent: false,
      intersects: false,
      enter: null,
      exit: null
    };

    const a = (lineEnd.x - lineStart.x) * (lineEnd.x - lineStart.x) +
              (lineEnd.y - lineStart.y) * (lineEnd.y - lineStart.y);
    const b = 2 * ((lineEnd.x - lineStart.x) * (lineStart.x - circleCenter.x) +
              (lineEnd.y - lineStart.y) * (lineStart.y - circleCenter.y));
    const c = circleCenter.x * circleCenter.x + circleCenter.y * circleCenter.y +
              lineStart.x * lineStart.x + lineStart.y * lineStart.y -
              2 * (circleCenter.x * lineStart.x + circleCenter.y * lineStart.y) -
              circleRadius * circleRadius;

    const discriminant = this.fixNumber(b * b - 4 * a * c);

    if (discriminant <= 0) {
      result.inside = false;
      return result;
    }

    const sqrtDisc = this.fixNumber(Math.sqrt(discriminant));
    const t1 = this.fixNumber((-b + sqrtDisc) / (2 * a));
    const t2 = this.fixNumber((-b - sqrtDisc) / (2 * a));

    if ((t1 < 0 || t1 > 1) && (t2 < 0 || t2 > 1)) {
      if (!((t1 < 0 && t2 < 0) || (t1 > 1 && t2 > 1))) {
        result.inside = true;
      }
      return result;
    }

    if (t2 >= 0 && t2 <= 1) {
      result.enter = Point.interpolate(lineStart, lineEnd, t2);
      result.enter = new Point(
        this.fixNumber(result.enter.x),
        this.fixNumber(result.enter.y)
      );
    }

    if (t1 >= 0 && t1 <= 1) {
      result.exit = Point.interpolate(lineStart, lineEnd, t1);
      result.exit = new Point(
        this.fixNumber(result.exit.x),
        this.fixNumber(result.exit.y)
      );
    }

    result.intersects = true;

    if (result.exit && result.enter && result.exit.equals(result.enter)) {
      result.tangent = true;
    }

    return result;
  }

  static circleIntersectCircle(x1, y1, r1, x2, y2, r2) {
    if (r1 < 0 || r2 < 0) return null;

    const dist = Math.sqrt((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2));
    
    if (dist > r1 + r2) return null;

    const a = (r1 * r1 + dist * dist - r2 * r2) / (2 * dist);
    const h = Math.sqrt(r1 * r1 - a * a);

    return {
      x3: (x2 - x1) * a / dist + (y2 - y1) * h / dist + x1,
      y3: (y2 - y1) * a / dist - (x2 - x1) * h / dist + y1,
      x4: (x2 - x1) * a / dist - (y2 - y1) * h / dist + x1,
      y4: (y2 - y1) * a / dist + (x2 - x1) * h / dist + y1
    };
  }
}

module.exports = { Maths, Point };
