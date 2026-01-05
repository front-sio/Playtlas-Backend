const { Maths } = require('./maths');

const Vector2D = function (x, y) {
  this.xValue = Maths.fixNumber(x);
  this.yValue = Maths.fixNumber(y);
};

Vector2D.prototype = {
  get x() {
    return this.xValue;
  },
  set x(value) {
    this.xValue = Maths.fixNumber(value);
  },
  get y() {
    return this.yValue;
  },
  set y(value) {
    this.yValue = Maths.fixNumber(value);
  },
  get angle() {
    return Maths.fixNumber(Math.atan2(this.yValue, this.xValue) * (180 / Math.PI));
  },
  set angle(value) {
    let angle = 0;
    if (!Number.isNaN(Number(value))) {
      angle = Number(value) * (Math.PI / 180);
    }
    const mag = Math.sqrt(this.xValue * this.xValue + this.yValue * this.yValue);
    this.xValue = Maths.fixNumber(mag * Math.cos(angle));
    this.yValue = Maths.fixNumber(mag * Math.sin(angle));
  },
  get magnitude() {
    return Maths.fixNumber(Math.sqrt(this.xValue * this.xValue + this.yValue * this.yValue));
  },
  get magnitudeSquared() {
    return Maths.fixNumber(this.xValue * this.xValue + this.yValue * this.yValue);
  },
  set magnitude(value) {
    if (Number.isNaN(Number(value))) {
      this.xValue = 0;
      this.yValue = 0;
      return;
    }
    const mag = Math.sqrt(this.xValue * this.xValue + this.yValue * this.yValue);
    if (mag > 0) {
      this.times(Number(value) / mag);
      return;
    }
    this.yValue = 0;
    this.xValue = Maths.fixNumber(value);
  },
};

Vector2D.prototype.plus = function (vector) {
  const v = new Vector2D(this.xValue, this.yValue);
  v.xValue += vector.xValue;
  v.yValue += vector.yValue;
  v.xValue = Maths.fixNumber(v.xValue);
  v.yValue = Maths.fixNumber(v.yValue);
  return v;
};

Vector2D.prototype.minus = function (vector) {
  const v = new Vector2D(this.xValue, this.yValue);
  v.xValue -= vector.xValue;
  v.yValue -= vector.yValue;
  v.xValue = Maths.fixNumber(v.xValue);
  v.yValue = Maths.fixNumber(v.yValue);
  return v;
};

Vector2D.prototype.times = function (value) {
  const v = new Vector2D(this.xValue, this.yValue);
  if (value instanceof Vector2D) {
    v.xValue *= value.xValue;
    v.yValue *= value.yValue;
  } else {
    v.xValue *= value;
    v.yValue *= value;
  }
  v.xValue = Maths.fixNumber(v.xValue);
  v.yValue = Maths.fixNumber(v.yValue);
  return v;
};

Vector2D.prototype.rotate = function (angle) {
  const v = new Vector2D(this.xValue, this.yValue);
  if (Number.isNaN(Number(angle))) return v;
  const mag = Math.sqrt(v.xValue * v.xValue + v.yValue * v.yValue);
  const rad = (Math.atan2(v.yValue, v.xValue) * (180 / Math.PI) + Number(angle)) * (Math.PI / 180);
  v.xValue = Maths.fixNumber(mag * Math.cos(rad));
  v.yValue = Maths.fixNumber(mag * Math.sin(rad));
  return v;
};

Vector2D.prototype.invert = function () {
  const v = new Vector2D(this.xValue, this.yValue);
  v.xValue *= -1;
  v.yValue *= -1;
  return v;
};

Vector2D.prototype.normalize = function () {
  const v = new Vector2D(this.xValue, this.yValue);
  return v.times(1 / v.magnitude);
};

Vector2D.prototype.project = function (vector) {
  const v = new Vector2D(this.xValue, this.yValue);
  if (vector instanceof Vector2D) {
    const scalar = v.dot(vector) / Math.pow(vector.magnitude, 2);
    v.x = vector.x;
    v.y = vector.y;
    return v.times(scalar);
  }
  return v;
};

Vector2D.prototype.reflect = function (vector) {
  const v = new Vector2D(this.xValue, this.yValue);
  if (vector instanceof Vector2D) {
    const normal = new Vector2D(vector.yValue, -vector.xValue);
    let angle = 2 * v.angleBetween(vector);
    if (v.angleBetweenCos(normal) <= 0) {
      angle *= -1;
    }
    return v.rotate(angle);
  }
  return v;
};

Vector2D.prototype.dot = function (vector) {
  if (!(vector instanceof Vector2D)) return 0;
  return Maths.fixNumber(this.xValue * vector.xValue + this.yValue * vector.yValue);
};

Vector2D.prototype.cross = function (vector) {
  if (!(vector instanceof Vector2D)) return 0;
  return Math.abs(Maths.fixNumber(this.xValue * vector.yValue - this.yValue * vector.xValue));
};

Vector2D.prototype.angleBetween = function (vector) {
  if (!(vector instanceof Vector2D)) return 0;
  return Maths.fixNumber(Math.acos(this.dot(vector) / (this.magnitude * vector.magnitude)) * (180 / Math.PI));
};

Vector2D.prototype.angleBetweenSin = function (vector) {
  if (!(vector instanceof Vector2D)) return 0;
  return Maths.fixNumber(this.cross(vector) / (this.magnitude * vector.magnitude));
};

Vector2D.prototype.angleBetweenCos = function (vector) {
  if (!(vector instanceof Vector2D)) return 0;
  return Maths.fixNumber(this.dot(vector) / (this.magnitude * vector.magnitude));
};

Vector2D.prototype.swap = function (vector) {
  if (vector instanceof Vector2D) {
    const x = this.xValue;
    const y = this.yValue;
    this.xValue = vector.xValue;
    this.yValue = vector.yValue;
    vector.xValue = x;
    vector.yValue = y;
  }
  return this;
};

Vector2D.prototype.getRightNormal = function () {
  return new Vector2D(this.yValue, -this.xValue);
};

Vector2D.prototype.getLeftNormal = function () {
  return new Vector2D(-this.yValue, this.xValue);
};

Vector2D.prototype.isNormalTo = function (vector) {
  return vector instanceof Vector2D && this.dot(vector) === 0;
};

Vector2D.prototype.isEqualTo = function (vector) {
  return vector instanceof Vector2D && this.xValue === vector.xValue && this.yValue === vector.yValue;
};

module.exports = Vector2D;
