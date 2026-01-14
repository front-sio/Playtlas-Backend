// backend/services/game-service/src/engine/8ball/physics.js
const { Maths, Point } = require('./maths');
const Vector2D = require('./vector2d');

class BilliardPhysics {
  constructor({
    ballArray,
    lineArray,
    vertexArray,
    pocketArray,
    contactHandler,
    simType = 0,
    ballRadius,
    pocketRadius,
    friction,
    minVelocity,
    cushionRestitution,
    ballRestitution,
  }) {
    this.targetID = -1;
    this.omissionArray = [];
    this.ballArray = ballArray;
    this.lineArray = lineArray;
    this.vertexArray = vertexArray;
    this.pocketArray = pocketArray;
    this.simType = simType;
    this.contactHandler = contactHandler;
    this.ballRadius = ballRadius;
    this.pocketRadius = pocketRadius;
    this.friction = friction;
    this.minVelocity = minVelocity;
    this.cushionRestitution = cushionRestitution;
    this.ballRestitution = ballRestitution;
    this.frame = 0;
  }

  set ballData(data) {
    this.ballArray = data;
  }

  set frameNumber(frame) {
    this.frame = frame;
  }

  updatePhysics() {
    this.predictCollisions();
    this.updateFriction();
  }

  predictCollisions() {
    let time = 0;
    let iterations = 0;
    let collisions = [];

    do {
      let closestTime = 1;
      collisions = [];
      const timeRemaining = Maths.fixNumber(1 - time);
      let range = 0;

      if (this.simType === 0) range = this.ballArray.length;
      if (this.simType === 1) range = 1;
      if (this.simType === 2) range = this.targetID === -1 ? 1 : this.ballArray.length;

      for (let a = 0; a < range; a++) {
        let skipBall = false;
        if (this.simType === 2 && this.targetID !== -1 && a !== this.targetID && a !== 0) {
          skipBall = true;
        }
        const ball = this.ballArray[a];
        if (ball.active !== 1 || skipBall) continue;

        const nextPos = ball.position.plus(ball.velocity.times(timeRemaining));
        for (let p = this.simType === 2 ? 0 : a; p < this.ballArray.length; p++) {
          const target = this.ballArray[p];
          if (ball.velocity.magnitudeSquared === 0 && target.velocity.magnitudeSquared === 0) continue;
          if (target === ball || target.active !== 1) continue;
          if (!Maths.checkObjectsConverging(ball.position, target.position, ball.velocity, target.velocity)) continue;

          const relVel = ball.velocity.minus(target.velocity);
          const futurePos = ball.position.plus(relVel.times(timeRemaining));
          const start = new Point(ball.position.x, ball.position.y);
          const end = new Point(futurePos.x, futurePos.y);
          const targetPos = new Point(target.position.x, target.position.y);
          const radius = 2 * this.ballRadius;
          const intersect = Maths.lineIntersectCircle(start, end, targetPos, radius);

          if (intersect.intersects || intersect.inside) {
            let hitPoint;
            let hitTime;
            if (intersect.intersects) {
              hitPoint = intersect.enter || intersect.exit;
              const lineVec = Maths.createVectorFrom2Points(start, end);
              const distVec = Maths.createVectorFrom2Points(start, hitPoint);
              hitTime = Maths.fixNumber(time + (distVec.magnitude / lineVec.magnitude) * timeRemaining);
            } else {
              const normal = ball.position.minus(target.position).normalize();
              hitPoint = target.position.plus(normal.times(radius));
              hitTime = time;
            }

            if (hitTime < closestTime) {
              closestTime = hitTime;
              collisions = [];
              collisions.push({
                type: 'ball',
                object: ball,
                time: closestTime,
                objectIntersectPoint: ball.position.plus(ball.velocity.times(closestTime - time)),
                target,
                targetIntersectPoint: target.position.plus(target.velocity.times(closestTime - time)),
              });
            } else if (hitTime === closestTime && hitTime !== 1) {
              collisions.push({
                type: 'ball',
                object: ball,
                time: closestTime,
                objectIntersectPoint: ball.position.plus(ball.velocity.times(closestTime - time)),
                target,
                targetIntersectPoint: target.position.plus(target.velocity.times(closestTime - time)),
              });
            }
          }
        }

        if (ball.velocity.magnitudeSquared !== 0) {
          for (let i = 0; i < this.lineArray.length; i++) {
            const line = this.lineArray[i];
            let hit = Maths.lineIntersectLine(
              new Point(ball.position.x, ball.position.y),
              new Point(nextPos.x, nextPos.y),
              new Point(line.p3.x, line.p3.y),
              new Point(line.p4.x, line.p4.y)
            );

            if (!hit) {
              const fallback = Maths.lineIntersectLine(
                new Point(ball.position.x, ball.position.y),
                new Point(nextPos.x, nextPos.y),
                new Point(line.p5.x, line.p5.y),
                new Point(line.p6.x, line.p6.y)
              );
              if (fallback) {
                const hitVec = new Vector2D(fallback.x, fallback.y);
                const offset = line.normal.times(0.2 * this.ballRadius);
                const adjusted = hitVec.plus(offset);
                hit = new Point(adjusted.x, adjusted.y);
              }
            }

            if (hit) {
              const hitVec = new Vector2D(hit.x, hit.y);
              const lineVec = Maths.createVectorFrom2Points(ball.position, nextPos);
              const hitDist = Maths.createVectorFrom2Points(ball.position, hitVec);
              const hitTime = Maths.fixNumber(time + (hitDist.magnitude / lineVec.magnitude) * timeRemaining);
              if (hitTime < closestTime) {
                closestTime = hitTime;
                collisions = [];
                collisions.push({
                  type: 'line',
                  time: closestTime,
                  object: ball,
                  objectIntersectPoint: hitVec,
                  target: line,
                });
              } else if (hitTime === closestTime && hitTime !== 1) {
                collisions.push({
                  type: 'line',
                  time: closestTime,
                  object: ball,
                  objectIntersectPoint: hitVec,
                  target: line,
                });
              }
            }
          }

          for (let i = 0; i < this.vertexArray.length; i++) {
            const vertex = this.vertexArray[i];
            let check = true;
            if (this.simType !== 1) {
              check =
                Math.abs(ball.position.x - vertex.position.x) < 8000 &&
                Math.abs(ball.position.y - vertex.position.y) < 8000;
            }
            if (!check) continue;

            const start = new Point(ball.position.x, ball.position.y);
            const end = new Point(nextPos.x, nextPos.y);
            const center = new Point(vertex.position.x, vertex.position.y);
            const intersect = Maths.lineIntersectCircle(start, end, center, this.ballRadius);
            if (intersect.intersects || intersect.inside) {
              let hitPoint;
              let hitTime;
              if (intersect.intersects) {
                hitPoint = intersect.enter || intersect.exit;
                const lineVec = Maths.createVectorFrom2Points(start, end);
                const hitVec = Maths.createVectorFrom2Points(start, hitPoint);
                hitTime = Maths.fixNumber(time + (hitVec.magnitude / lineVec.magnitude) * timeRemaining);
              } else {
                const offset = ball.position.plus(ball.velocity.normalize().times(2 * -this.ballRadius));
                const exitPoint = Maths.lineIntersectCircle(start, new Point(offset.x, offset.y), center, this.ballRadius).exit;
                hitPoint = new Vector2D(exitPoint.x, exitPoint.y);
                hitTime = time;
              }

              if (hitTime < closestTime) {
                closestTime = hitTime;
                collisions = [];
                collisions.push({
                  type: 'vertex',
                  time: closestTime,
                  object: ball,
                  objectIntersectPoint: intersect.intersects ? new Vector2D(hitPoint.x, hitPoint.y) : hitPoint,
                  target: vertex,
                });
              } else if (hitTime === closestTime && hitTime !== 1) {
                collisions.push({
                  type: 'vertex',
                  time: closestTime,
                  object: ball,
                  objectIntersectPoint: intersect.intersects ? new Vector2D(hitPoint.x, hitPoint.y) : hitPoint,
                  target: vertex,
                });
              }
            }
          }

          for (let i = 0; i < this.pocketArray.length; i++) {
            const pocket = this.pocketArray[i];
            let check = true;
            if (this.simType !== 1) {
              check =
                Math.abs(ball.position.x - pocket.position.x) < 8000 &&
                Math.abs(ball.position.y - pocket.position.y) < 8000;
            }
            if (!check) continue;

            const towardPocket = pocket.position.minus(ball.position).normalize();
            const movingToPocket = ball.velocity.dot(towardPocket) > 0;
            if (!movingToPocket) continue;

            const start = new Point(ball.position.x, ball.position.y);
            const end = new Point(nextPos.x, nextPos.y);
            const center = new Point(pocket.position.x, pocket.position.y);
            const pocketRadius = pocket.radius ? pocket.radius : this.pocketRadius;
            const intersect = Maths.lineIntersectCircle(start, end, center, pocketRadius);

            if (intersect.intersects || intersect.inside) {
              let hitPoint;
              let hitTime;
              if (intersect.intersects) {
                hitPoint = intersect.enter || intersect.exit;
                const lineVec = Maths.createVectorFrom2Points(start, end);
                const hitVec = Maths.createVectorFrom2Points(start, hitPoint);
                hitTime = Maths.fixNumber(time + (hitVec.magnitude / lineVec.magnitude) * timeRemaining);
              } else {
                const normal = Maths.createVectorFrom2Points(center, start).normalize();
                hitPoint = new Vector2D(center.x, center.y).plus(normal.times(pocketRadius));
                hitTime = time;
              }

              if (hitTime < closestTime) {
                closestTime = hitTime;
                collisions = [];
                collisions.push({
                  type: 'pocket',
                  time: closestTime,
                  object: ball,
                  objectIntersectPoint: intersect.intersects ? new Vector2D(hitPoint.x, hitPoint.y) : hitPoint,
                  target: pocket,
                });
              } else if (hitTime === closestTime && hitTime !== 1) {
                collisions.push({
                  type: 'pocket',
                  time: closestTime,
                  object: ball,
                  objectIntersectPoint: intersect.intersects ? new Vector2D(hitPoint.x, hitPoint.y) : hitPoint,
                  target: pocket,
                });
              }
            }
          }
        }
      }

      if (collisions.length > 0) this.resolveCollision(collisions);

      const delta = Maths.fixNumber(closestTime - time);
      if (this.simType !== 1) {
        this.moveBalls(delta);
      }
      time = closestTime;
      iterations++;
    } while (collisions.length > 0 && iterations < 20);
  }

  resolveCollision(collisions) {
    this.omissionArray = [];

    for (let i = 0; i < collisions.length; i++) {
      const collision = collisions[i];
      let normalVelocity;
      let object = collision.object;

      if (collision.type === 'ball') {
        object.position = collision.objectIntersectPoint;
        const target = collision.target;
        if (this.targetID === -1) this.targetID = target.id;
        target.position = collision.targetIntersectPoint;
        this.omissionArray.push(object);
        this.omissionArray.push(target);

        const normal = target.position.minus(object.position).normalize();
        const tangent = new Vector2D(normal.x, normal.y).getRightNormal();
        const a = normal.times(object.velocity.dot(normal));
        const b = tangent.times(object.velocity.dot(tangent));
        const c = normal.times(target.velocity.dot(normal));
        const d = tangent.times(target.velocity.dot(tangent));

        if (Math.abs(target.ySpin) < Math.abs(object.ySpin)) {
          target.ySpin = -0.5 * object.ySpin;
        }
        if (object.id === 0 && object.firstContact === 0) {
          object.deltaScrew = a.times(0.17 * -object.screw);
        }

        const impulseTarget = c.times(this.ballRestitution).plus(a.times(1 - this.ballRestitution));
        const impulseObject = a.times(this.ballRestitution).plus(c.times(1 - this.ballRestitution));
        object.velocity = b.plus(impulseTarget);
        target.velocity = d.plus(impulseObject);
        if (this.simType === 0 && impulseObject.magnitude > 450) {
          target.grip = 0;
        }
        object.lastCollisionObject = target;
        target.lastCollisionObject = object;
      }

      if (collision.type === 'line') {
        object.position = collision.objectIntersectPoint;
        const line = collision.target;
        this.omissionArray.push(object);
        object.ySpin += -object.velocity.dot(line.direction) / 100;
        if (object.ySpin > 50) object.ySpin = 50;
        if (object.ySpin < -50) object.ySpin = -50;

        const a = line.normal.times(object.velocity.dot(line.normal));
        const b = line.direction.times(object.velocity.dot(line.direction));
        if (object.id === 0) {
          const english = line.direction.times(Maths.fixNumber(0.2 * object.english * object.velocity.magnitude));
          object.velocity = a.times(-this.cushionRestitution).plus(b.plus(english));
          object.english = Maths.fixNumber(0.5 * object.english);
          if (object.english > -0.1 && object.english < 0.1) object.english = 0;
        } else {
          object.velocity = a.times(-this.cushionRestitution).plus(b);
        }

        if (this.simType === 0 && a.magnitude > 700) {
          object.grip = 0;
        }
        object.lastCollisionObject = line;
        object.position = object.position.plus(line.normal.times(200));
        if (object.id === 0) {
          object.deltaScrew = object.deltaScrew.times(0.8);
        }
        normalVelocity = a;
      }

      if (collision.type === 'vertex') {
        object.position = collision.objectIntersectPoint;
        const vertex = collision.target;
        this.omissionArray.push(object);
        const normal = vertex.position.minus(object.position).normalize();
        const tangent = new Vector2D(normal.x, normal.y).getRightNormal();
        const a = normal.times(object.velocity.dot(normal));
        const b = tangent.times(object.velocity.dot(tangent));
        object.velocity = a.times(-this.cushionRestitution).plus(b);
        object.position = object.position.minus(normal.times(200));
        object.lastCollisionObject = vertex;
        object.lastVertex = vertex.name;
        if (object.id === 0) {
          object.deltaScrew = new Vector2D(0, 0);
        }
        normalVelocity = a;
      }

      if (collision.type === 'pocket') {
        object.position = collision.objectIntersectPoint;
        this.omissionArray.push(object);
      }

      const contact = {
        collisionType: collision.type,
        ball: object,
        target: collision.target,
        ballVelocity: object.velocity,
        time: collision.time,
      };

      if (collision.type === 'ball') {
        contact.targetVelocity = collision.target.velocity;
        if (object.id === 0) {
          contact.deltaScrew = object.deltaScrew;
        }
      }

      if (collision.type === 'line' || collision.type === 'vertex') {
        contact.normalVelocity = normalVelocity;
      }

      if (collision.type === 'pocket') {
        contact.speed = object.velocity.magnitude;
      }

      if (this.contactHandler) {
        this.contactHandler(contact);
        if (collision.type === 'ball') {
          const mirror = {
            collisionType: collision.type,
            ball: collision.target,
            target: object,
            ballVelocity: collision.target.velocity,
            targetVelocity: object.velocity,
            time: collision.time,
          };
          if (collision.target.id === 0) {
            mirror.deltaScrew = collision.target.deltaScrew;
          }
          this.contactHandler(mirror);
        }
      }
    }
  }

  moveBalls(delta) {
    for (let i = 0; i < this.ballArray.length; i++) {
      const ball = this.ballArray[i];
      if (this.omissionArray.length !== 0 && this.omissionArray.indexOf(ball) !== -1) {
        continue;
      }
      if (ball.active === 1) {
        ball.position = ball.position.plus(ball.velocity.times(delta));
      }
    }
    this.omissionArray = [];
  }

  updateFriction() {
    for (let i = 0; i < this.ballArray.length; i++) {
      const ball = this.ballArray[i];
      if (ball.id === 0) {
        ball.velocity = ball.velocity.plus(ball.deltaScrew);
        if (ball.deltaScrew.magnitude > 0) {
          ball.deltaScrew = ball.deltaScrew.times(0.8);
          if (ball.deltaScrew.magnitude < 1) {
            ball.deltaScrew = new Vector2D(0, 0);
          }
        }
      }

      let speed = ball.velocity.magnitude;
      speed -= this.friction;
      const direction = ball.velocity.normalize();
      ball.velocity = direction.times(speed);
      if (ball.velocity.magnitude < this.minVelocity) {
        ball.velocity = new Vector2D(0, 0);
      }

      if (ball.grip < 1) {
        ball.grip += 0.02;
      }

      if (ball.ySpin >= 0.2) ball.ySpin -= 0.2;
      if (ball.ySpin <= -0.2) ball.ySpin += 0.2;
      if (ball.ySpin >= -0.2 && ball.ySpin <= 0.2) ball.ySpin = 0;

      if (ball.ySpin !== 0) {
        const side = ball.velocity.getLeftNormal().normalize().times(0.3 * ball.ySpin * ball.velocity.magnitude / 800);
        ball.velocity = ball.velocity.plus(side);
      }
    }
  }
}

module.exports = BilliardPhysics;
