// backend/services/game-service/src/engine/8ball/server-vector2d.js
/**
 * Server-side Vector2D - Ported from client Phaser.js game
 * Used for all physics calculations on authoritative server
 */

class Vector2D {
  constructor(x = 0, y = 0) {
    this.xValue = this.fixNumber(x);
    this.yValue = this.fixNumber(y);
  }

  get x() {
    return this.xValue;
  }

  set x(value) {
    this.xValue = this.fixNumber(value);
  }

  get y() {
    return this.yValue;
  }

  set y(value) {
    this.yValue = this.fixNumber(value);
  }

  get angle() {
    return this.fixNumber(Math.atan2(this.yValue, this.xValue) * (180 / Math.PI));
  }

  set angle(degrees) {
    const radians = Number(degrees) * (Math.PI / 180);
    const mag = Math.sqrt(this.xValue * this.xValue + this.yValue * this.yValue);
    this.xValue = this.fixNumber(mag * Math.cos(radians));
    this.yValue = this.fixNumber(mag * Math.sin(radians));
  }

  get magnitude() {
    return this.fixNumber(Math.sqrt(this.xValue * this.xValue + this.yValue * this.yValue));
  }

  get magnitudeSquared() {
    return this.fixNumber(this.xValue * this.xValue + this.yValue * this.yValue);
  }

  set magnitude(value) {
    const currentMag = Math.sqrt(this.xValue * this.xValue + this.yValue * this.yValue);
    if (currentMag > 0) {
      this.xValue = this.fixNumber((this.xValue / currentMag) * value);
      this.yValue = this.fixNumber((this.yValue / currentMag) * value);
    } else {
      this.xValue = this.fixNumber(value);
      this.yValue = 0;
    }
  }

  plus(v) {
    return new Vector2D(
      this.fixNumber(this.xValue + v.xValue),
      this.fixNumber(this.yValue + v.yValue)
    );
  }

  minus(v) {
    return new Vector2D(
      this.fixNumber(this.xValue - v.xValue),
      this.fixNumber(this.yValue - v.yValue)
    );
  }

  times(scalar) {
    if (scalar instanceof Vector2D) {
      return new Vector2D(
        this.fixNumber(this.xValue * scalar.xValue),
        this.fixNumber(this.yValue * scalar.yValue)
      );
    }
    return new Vector2D(
      this.fixNumber(this.xValue * scalar),
      this.fixNumber(this.yValue * scalar)
    );
  }

  rotate(degrees) {
    const mag = Math.sqrt(this.xValue * this.xValue + this.yValue * this.yValue);
    const currentAngle = Math.atan2(this.yValue, this.xValue) * (180 / Math.PI);
    const newAngle = (currentAngle + Number(degrees)) * (Math.PI / 180);
    return new Vector2D(
      this.fixNumber(mag * Math.cos(newAngle)),
      this.fixNumber(mag * Math.sin(newAngle))
    );
  }

  invert() {
    return new Vector2D(-this.xValue, -this.yValue);
  }

  normalize() {
    const mag = this.magnitude;
    if (mag === 0) return new Vector2D(0, 0);
    return this.times(1 / mag);
  }

  dot(v) {
    if (!(v instanceof Vector2D)) return 0;
    return this.fixNumber(this.xValue * v.xValue + this.yValue * v.yValue);
  }

  cross(v) {
    if (!(v instanceof Vector2D)) return 0;
    return Math.abs(this.fixNumber(this.xValue * v.yValue - this.yValue * v.xValue));
  }

  getRightNormal() {
    return new Vector2D(this.yValue, -this.xValue);
  }

  getLeftNormal() {
    return new Vector2D(-this.yValue, this.xValue);
  }

  angleBetween(v) {
    if (!(v instanceof Vector2D)) return 0;
    const cos = this.dot(v) / (this.magnitude * v.magnitude);
    return this.fixNumber(Math.acos(cos) * (180 / Math.PI));
  }

  isEqualTo(v) {
    return v instanceof Vector2D && this.xValue === v.xValue && this.yValue === v.yValue;
  }

  fixNumber(value) {
    if (isNaN(Number(value))) return 0;
    return Math.round(Number(value) * 10000) / 10000;
  }
}

module.exports = Vector2D;
