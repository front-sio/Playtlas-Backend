// backend/services/game-service/src/engine/8ball/server-physics-engine.js
/**
 * AUTHORITATIVE SERVER-SIDE PHYSICS ENGINE
 * Ported from frontend/public/8ball-match-withai/assets/src/04billiardPhysics.js
 * 
 * This is the ONLY place physics calculations happen for real money games.
 * Client receives results only - cannot manipulate physics.
 */

const Vector2D = require('./server-vector2d');
const { Maths, Point } = require('./server-maths');
const Ball = require('./server-ball');
const logger = require('../../utils/logger');

class BilliardPhysics {
  constructor(options) {
    this.ballArray = options.ballArray;
    this.lineArray = options.lineArray;
    this.vertexArray = options.vertexArray || [];
    this.pocketArray = options.pocketArray;
    this.ballRadius = options.ballRadius;
    this.pocketRadius = options.pocketRadius;
    this.friction = options.friction;
    this.minVelocity = options.minVelocity;
    this.cushionRestitution = options.cushionRestitution;
    this.ballRestitution = options.ballRestitution;
    
    // Simulation tracking
    this.targetID = -1;
    this.omissionArray = [];
    this.frame = 0;
    this.simType = 0; // 0 = full sim, 1 = cue only, 2 = cue + target
    
    // Contact events for rules engine
    this.contactEvents = [];
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
      
      // Determine which balls to check based on sim type
      let range = 0;
      if (this.simType === 0) range = this.ballArray.length;
      if (this.simType === 1) range = 1;
      if (this.simType === 2) range = this.targetID === -1 ? 1 : this.ballArray.length;

      // Check each active ball for collisions
      for (let a = 0; a < range; a++) {
        const ball = this.ballArray[a];
        if (ball.active !== 1) continue;

        // Skip ball if not relevant for targeted simulation
        if (this.simType === 2 && this.targetID !== -1 && a !== this.targetID && a !== 0) {
          continue;
        }

        const nextPos = ball.position.plus(ball.velocity.times(timeRemaining));

        // BALL-TO-BALL COLLISIONS
        for (let p = (this.simType === 2 ? 0 : a); p < this.ballArray.length; p++) {
          const target = this.ballArray[p];
          
          if (target === ball || target.active !== 1) continue;
          if (ball.velocity.magnitudeSquared === 0 && target.velocity.magnitudeSquared === 0) continue;
          
          // Check if objects are converging
          if (!Maths.checkObjectsConverging(ball.position, target.position, ball.velocity, target.velocity)) {
            continue;
          }

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
              // Ball already overlapping
              const normal = ball.position.minus(target.position).normalize();
              hitPoint = target.position.plus(normal.times(radius));
              hitTime = time;
            }

            if (hitTime < closestTime) {
              closestTime = hitTime;
              collisions = [];
              const collision = {
                type: 'ball',
                object: ball,
                time: closestTime,
                objectIntersectPoint: intersect.intersects 
                  ? ball.position.plus(ball.velocity.times(hitTime - time))
                  : new Vector2D(hitPoint.x, hitPoint.y),
                target: target,
                targetIntersectPoint: intersect.intersects
                  ? target.position.plus(target.velocity.times(hitTime - time))
                  : target.position
              };
              collisions.push(collision);
            } else if (hitTime === closestTime && hitTime !== 1) {
              // Simultaneous collision
              const collision = {
                type: 'ball',
                object: ball,
                time: closestTime,
                objectIntersectPoint: ball.position.plus(ball.velocity.times(hitTime - time)),
                target: target,
                targetIntersectPoint: target.position.plus(target.velocity.times(hitTime - time))
              };
              collisions.push(collision);
            }
          }
        }

        // BALL-TO-CUSHION COLLISIONS
        if (ball.velocity.magnitudeSquared !== 0) {
          for (const line of this.lineArray) {
            const lineStart = new Point(ball.position.x, ball.position.y);
            const lineEnd = new Point(nextPos.x, nextPos.y);
            
            let intersection = Maths.lineIntersectLine(lineStart, lineEnd, line.p3, line.p4);
            
            // Fallback to secondary line check
            if (!intersection) {
              intersection = Maths.lineIntersectLine(lineStart, lineEnd, line.p5, line.p6);
            }

            if (intersection) {
              const hitPoint = new Vector2D(intersection.x, intersection.y);
              const pathVec = Maths.createVectorFrom2Points(ball.position, nextPos);
              const distVec = Maths.createVectorFrom2Points(ball.position, hitPoint);
              const hitTime = Maths.fixNumber(time + (distVec.magnitude / pathVec.magnitude) * timeRemaining);

              if (hitTime < closestTime) {
                closestTime = hitTime;
                collisions = [];
                collisions.push({
                  type: 'line',
                  time: hitTime,
                  object: ball,
                  objectIntersectPoint: hitPoint,
                  target: line
                });
              } else if (hitTime === closestTime && hitTime !== 1) {
                collisions.push({
                  type: 'line',
                  time: hitTime,
                  object: ball,
                  objectIntersectPoint: hitPoint,
                  target: line
                });
              }
            }
          }

          // BALL-TO-POCKET COLLISIONS
          for (const pocket of this.pocketArray) {
            // Check if ball is moving toward pocket
            const toPocket = pocket.position.minus(ball.position).normalize();
            if (ball.velocity.dot(toPocket) <= 0) continue;

            const start = new Point(ball.position.x, ball.position.y);
            const end = new Point(nextPos.x, nextPos.y);
            const pocketPos = new Point(pocket.position.x, pocket.position.y);
            const pocketRad = pocket.radius || this.pocketRadius;
            
            const intersect = Maths.lineIntersectCircle(start, end, pocketPos, pocketRad);

            if (intersect.intersects || intersect.inside) {
              let hitPoint;
              let hitTime;

              if (intersect.intersects) {
                hitPoint = intersect.enter || intersect.exit;
                const lineVec = Maths.createVectorFrom2Points(start, end);
                const distVec = Maths.createVectorFrom2Points(start, hitPoint);
                hitTime = Maths.fixNumber(time + (distVec.magnitude / lineVec.magnitude) * timeRemaining);
              } else {
                const direction = Maths.createVectorFrom2Points(pocketPos, start).normalize();
                hitPoint = new Point(
                  pocketPos.x + direction.x * pocketRad,
                  pocketPos.y + direction.y * pocketRad
                );
                hitTime = time;
              }

              if (hitTime < closestTime) {
                closestTime = hitTime;
                collisions = [];
                collisions.push({
                  type: 'pocket',
                  object: ball,
                  time: hitTime,
                  objectIntersectPoint: intersect.intersects 
                    ? new Vector2D(hitPoint.x, hitPoint.y)
                    : new Vector2D(hitPoint.x, hitPoint.y),
                  target: pocket
                });
              } else if (hitTime === closestTime && hitTime !== 1) {
                collisions.push({
                  type: 'pocket',
                  object: ball,
                  time: hitTime,
                  objectIntersectPoint: new Vector2D(hitPoint.x, hitPoint.y),
                  target: pocket
                });
              }
            }
          }
        }
      }

      // Resolve all collisions at this time
      if (collisions.length > 0) {
        this.resolveCollision(collisions);
      }

      // Move balls for the time slice
      const deltaTime = Maths.fixNumber(closestTime - time);
      if (this.simType !== 1) {
        this.moveBalls(deltaTime);
      }

      time = closestTime;
      iterations++;

    } while (collisions.length > 0 && iterations < 20);

    if (iterations >= 20) {
      logger.warn('[Physics] Max collision iterations reached');
    }
  }

  resolveCollision(collisions) {
    this.omissionArray = [];

    for (const collision of collisions) {
      const ball = collision.object;

      if (collision.type === 'ball') {
        this.resolveBallBallCollision(collision);
      } else if (collision.type === 'line') {
        this.resolveBallCushionCollision(collision);
      } else if (collision.type === 'pocket') {
        this.resolveBallPocketCollision(collision);
      }

      // Record contact event for rules engine
      this.contactEvents.push({
        type: collision.type,
        ball: ball,
        target: collision.target,
        time: collision.time
      });
    }
  }

  resolveBallBallCollision(collision) {
    const ball = collision.object;
    const target = collision.target;

    ball.position = collision.objectIntersectPoint;
    target.position = collision.targetIntersectPoint;

    this.omissionArray.push(ball, target);

    // Collision normal
    const normal = target.position.minus(ball.position).normalize();
    const tangent = normal.getRightNormal();

    // Decompose velocities
    const ballNormal = normal.times(ball.velocity.dot(normal));
    const ballTangent = tangent.times(ball.velocity.dot(tangent));
    const targetNormal = normal.times(target.velocity.dot(normal));
    const targetTangent = tangent.times(target.velocity.dot(tangent));

    // Transfer spin
    if (Math.abs(target.ySpin) < Math.abs(ball.ySpin)) {
      target.ySpin = -0.5 * ball.ySpin;
    }

    // Apply screw (bottom/top spin) on first contact
    if (ball.id === 0 && !ball.firstContact) {
      ball.deltaScrew = ballNormal.times(0.17 * -ball.screw);
      ball.firstContact = true;
    }

    // Exchange velocities with restitution
    const restitution = this.ballRestitution;
    const newBallNormal = targetNormal.times(restitution).plus(ballNormal.times(1 - restitution));
    const newTargetNormal = ballNormal.times(restitution).plus(targetNormal.times(1 - restitution));

    ball.velocity = ballTangent.plus(newBallNormal);
    target.velocity = targetTangent.plus(newTargetNormal);

    // Reset grip on hard impacts
    if (newTargetNormal.magnitude > 450) {
      target.grip = 0;
    }

    ball.lastCollisionObject = target;
    target.lastCollisionObject = ball;

    // Track first contact for rules
    if (!ball.contactArray.some(c => c.type === 'ball')) {
      ball.contactArray.push({ type: 'ball', collisionType: 'ball', target: target });
    }
  }

  resolveBallCushionCollision(collision) {
    const ball = collision.object;
    const cushion = collision.target;

    ball.position = collision.objectIntersectPoint;
    this.omissionArray.push(ball);

    // Add spin from cushion contact
    ball.ySpin += -ball.velocity.dot(cushion.direction) / 100;
    ball.ySpin = Math.max(-50, Math.min(50, ball.ySpin));

    // Decompose velocity
    const normalVel = cushion.normal.times(ball.velocity.dot(cushion.normal));
    let tangentVel = cushion.direction.times(ball.velocity.dot(cushion.direction));

    // Apply english (side spin) effect on cue ball
    if (ball.id === 0) {
      const speed = ball.velocity.magnitude;
      tangentVel = tangentVel.plus(cushion.direction.times(Maths.fixNumber(0.2 * ball.english * speed)));
      ball.english = Maths.fixNumber(0.5 * ball.english);
      if (Math.abs(ball.english) < 0.1) ball.english = 0;
    }

    // Apply cushion reflection
    ball.velocity = normalVel.times(-this.cushionRestitution).plus(tangentVel);

    // Reduce grip on hard cushion hits
    if (normalVel.magnitude > 700) {
      ball.grip = 0;
    }

    // Reduce screw effect
    if (ball.id === 0) {
      ball.deltaScrew = ball.deltaScrew.times(0.8);
    }

    // Move ball slightly away from cushion to prevent sticking
    ball.position = ball.position.plus(cushion.normal.times(200));

    ball.lastCollisionObject = cushion;
    ball.contactArray.push({ type: 'line', collisionType: 'line', target: cushion });
  }

  resolveBallPocketCollision(collision) {
    const ball = collision.object;
    const pocket = collision.target;

    ball.position = collision.objectIntersectPoint;
    ball.active = 0; // Ball pocketed
    ball.velocity = new Vector2D(0, 0);

    this.omissionArray.push(ball);

    ball.contactArray.push({ type: 'pocket', collisionType: 'pocket', target: pocket });
  }

  moveBalls(deltaTime) {
    for (let i = 0; i < this.ballArray.length; i++) {
      const ball = this.ballArray[i];
      
      // Skip balls in omission array (already moved during collision)
      if (this.omissionArray.includes(ball)) continue;
      if (ball.active !== 1) continue;

      ball.position = ball.position.plus(ball.velocity.times(deltaTime));
    }
    
    this.omissionArray = [];
  }

  updateFriction() {
    for (const ball of this.ballArray) {
      if (ball.active !== 1) continue;

      // Apply screw effect (decaying)
      if (ball.id === 0 && ball.deltaScrew) {
        ball.velocity = ball.velocity.plus(ball.deltaScrew);
        ball.deltaScrew = ball.deltaScrew.times(0.8);
        if (ball.deltaScrew.magnitude < 1) {
          ball.deltaScrew = new Vector2D(0, 0);
        }
      }

      // Apply friction
      let speed = ball.velocity.magnitude;
      speed -= this.friction;
      
      if (speed <= this.minVelocity) {
        ball.velocity = new Vector2D(0, 0);
      } else {
        const direction = ball.velocity.normalize();
        ball.velocity = direction.times(speed);
      }

      // Restore grip over time
      if (ball.grip < 1) {
        ball.grip += 0.02;
        if (ball.grip > 1) ball.grip = 1;
      }

      // Decay y-spin
      if (ball.ySpin >= 0.2) {
        ball.ySpin -= 0.2;
      } else if (ball.ySpin <= -0.2) {
        ball.ySpin += 0.2;
      } else if (ball.ySpin !== 0) {
        ball.ySpin = 0;
      }

      // Apply curve from y-spin
      if (ball.ySpin !== 0) {
        const spinEffect = ball.velocity.getLeftNormal().normalize().times(0.3 * ball.ySpin * ball.velocity.magnitude / 800);
        ball.velocity = ball.velocity.plus(spinEffect);
      }
    }
  }

  // Check if simulation is complete (all balls stopped)
  isComplete() {
    for (const ball of this.ballArray) {
      if (ball.active === 1 && ball.velocity.magnitudeSquared > 0) {
        return false;
      }
    }
    return true;
  }

  // Get contact events for rules engine
  getContactEvents() {
    return this.contactEvents;
  }

  clearContactEvents() {
    this.contactEvents = [];
  }
}

module.exports = BilliardPhysics;
