const Vector2D = require('./vector2d');
const { Point } = require('./maths');
const BilliardPhysics = require('./physics');
const { createTableGeometry } = require('./table');
const { setBallPositions } = require('./rack');
const { createRng } = require('./rng');
const { EightBallRules } = require('./rules');

const DEFAULTS = {
  adjustmentScale: 2.3,
  friction: 1.5,
  pocketRadius: 2250,
  minVelocity: 2,
  cushionRestitution: 0.6,
  ballRestitution: 0.94,
  maxPower: 5000,
};

function createBall(id, position, ballRadius) {
  const ball = {
    id,
    position: new Vector2D(position.x, position.y),
    velocity: new Vector2D(0, 0),
    active: 1,
    targetType: 'ANY',
    contactArray: [],
    firstContact: 0,
    lastCollisionObject: null,
    lastVertex: null,
    screw: 0,
    english: 0,
    deltaScrew: new Vector2D(0, 0),
    grip: 1,
    ySpin: 0,
    ballRadius,
  };

  if (id > 0 && id < 8) ball.targetType = 'SOLIDS';
  if (id > 8) ball.targetType = 'STRIPES';
  if (id === 8) ball.targetType = '8 BALL';
  return ball;
}

class EightBallEngine {
  constructor(options = {}) {
    const seed = options.seed ?? Date.now();
    this.rng = createRng(seed);
    this.seed = this.rng.seed;
    this.rules = new EightBallRules();
    this.config = { ...DEFAULTS, ...options };
    this.config.ballRadius = 1000 * this.config.adjustmentScale;
    this.table = createTableGeometry(this.config);
    this.state = this.createInitialState();
  }

  createInitialState() {
    const positions = setBallPositions({
      adjustmentScale: this.config.adjustmentScale,
      ballRadius: this.config.ballRadius,
      rng: this.rng,
    });

    const balls = [];
    for (let i = 0; i < positions.length; i++) {
      if (!positions[i]) continue;
      balls[i] = createBall(i, positions[i], this.config.ballRadius);
    }

    const rulesState = this.rules.getState();

    return {
      balls,
      shotNumber: 0,
      turn: rulesState.turn,
      cueBallInHand: true,
      scratched: false,
      pottedBallIds: [],
      winner: null,
      rulesState,
    };
  }

  loadState(snapshot) {
    if (!snapshot) return;
    if (snapshot.state) {
      this.state = snapshot.state;
      this.rules.setState(snapshot.state.rulesState || {});
      if (snapshot.seed) {
        this.seed = snapshot.seed;
        this.rng = createRng(snapshot.seed);
      }
      return;
    }
    this.state = snapshot;
    this.rules.setState(snapshot.rulesState || {});
  }

  getSnapshot() {
    return {
      seed: this.seed,
      state: JSON.parse(JSON.stringify(this.state)),
    };
  }

  resetContacts() {
    this.state.balls.forEach((ball) => {
      if (!ball) return;
      ball.contactArray = [];
      ball.firstContact = 0;
      ball.lastCollisionObject = null;
      ball.lastVertex = null;
    });
  }

  applyShot(playerId, shot, options = {}) {
    if (this.state.winner) {
      return { ok: false, error: 'Game over' };
    }

    if (this.state.turn !== playerId) {
      return { ok: false, error: 'Not your turn' };
    }

    const cueBall = this.state.balls[0];
    if (!cueBall || cueBall.active !== 1) {
      return { ok: false, error: 'Cue ball not available' };
    }

    if (typeof shot.power !== 'number' || shot.power <= 0 || shot.power > this.config.maxPower) {
      return { ok: false, error: 'Shot power is invalid' };
    }

    if (shot.screw !== undefined && (typeof shot.screw !== 'number' || Math.abs(shot.screw) > 1)) {
      return { ok: false, error: 'Shot screw is invalid' };
    }

    if (shot.english !== undefined && (typeof shot.english !== 'number' || Math.abs(shot.english) > 1)) {
      return { ok: false, error: 'Shot english is invalid' };
    }

    if (!this.state.cueBallInHand && shot.cueBallPosition) {
      return { ok: false, error: 'Cue ball placement not allowed' };
    }

    if (this.state.cueBallInHand && !shot.cueBallPosition) {
      return { ok: false, error: 'Cue ball placement required' };
    }

    if (this.state.cueBallInHand) {
      const placed = shot.cueBallPosition ? this.placeCueBall(shot.cueBallPosition) : this.recoverCueBall();
      if (!placed) {
        return { ok: false, error: 'Invalid cue ball placement' };
      }
    }

    const power = shot.power;
    const rawDir = new Vector2D(shot.direction.x, shot.direction.y);
    if (rawDir.magnitude === 0) {
      return { ok: false, error: 'Shot direction is invalid' };
    }
    const direction = rawDir.normalize();
    cueBall.screw = shot.screw ?? 0;
    cueBall.english = shot.english ?? 0;
    cueBall.deltaScrew = new Vector2D(0, 0);
    cueBall.velocity = direction.times(power);

    this.state.shotNumber += 1;
    this.state.cueBallInHand = false;
    this.state.scratched = false;
    this.state.pottedBallIds = [];
    this.resetContacts();

    const shotContext = this.createShotContext();
    const physics = new BilliardPhysics({
      ballArray: this.state.balls,
      lineArray: this.table.lines,
      vertexArray: this.table.vertices,
      pocketArray: this.table.pockets,
      contactHandler: (contact) => this.onContact(contact, shotContext),
      simType: 0,
      ballRadius: this.config.ballRadius,
      pocketRadius: this.config.pocketRadius,
      friction: this.config.friction,
      minVelocity: this.config.minVelocity,
      cushionRestitution: this.config.cushionRestitution,
      ballRestitution: this.config.ballRestitution,
    });

    let steps = 0;
    const maxSteps = 6000;
    const frames = [];
    const capture = options.capture || null;
    const stride = capture?.stride || 6;
    const maxFrames = capture?.maxFrames || 120;
    while (steps < maxSteps && !this.areBallsStopped()) {
      physics.frameNumber = steps;
      physics.updatePhysics();
      steps++;
      if (capture && steps % stride === 0 && frames.length < maxFrames) {
        frames.push(this.getSnapshot());
      }
    }

    const shotResult = this.buildShotResult(shotContext);
    const activeBalls = this.state.balls.filter((ball) => ball && ball.active === 1).map((ball) => ball.id);
    this.rules.updateActiveBalls(activeBalls);
    const rulesState = this.rules.evaluateShot(shotResult);
    this.state.rulesState = rulesState;
    this.state.turn = rulesState.turn;
    this.state.cueBallInHand = rulesState.ballInHand;
    this.state.winner = rulesState.winner;

    if (capture) {
      const finalSnap = this.getSnapshot();
      if (frames.length === 0 || frames[frames.length - 1]?.state?.shotNumber !== finalSnap.state.shotNumber) {
        frames.push(finalSnap);
      }
    }

    return { ok: true, shotResult, rulesState, frames };
  }

  recoverCueBall() {
    const cueBall = this.state.balls[0];
    if (!cueBall) return false;
    if (cueBall.active === 1) return true;
    return false;
  }

  placeCueBall(position) {
    const cueBall = this.state.balls[0];
    if (!cueBall) return false;
    const bounds = this.getTableBounds();
    const x = Math.min(Math.max(position.x, bounds.left), bounds.right);
    const y = Math.min(Math.max(position.y, bounds.top), bounds.bottom);

    const candidate = new Vector2D(x, y);
    for (let i = 0; i < this.table.pockets.length; i++) {
      const pocket = this.table.pockets[i];
      const dist = pocket.position.minus(candidate).magnitude;
      if (dist < this.config.pocketRadius * 1.1) {
        return false;
      }
    }
    for (let i = 1; i < this.state.balls.length; i++) {
      const ball = this.state.balls[i];
      if (!ball || ball.active !== 1) continue;
      const dist = ball.position.minus(candidate).magnitude;
      if (dist < this.config.ballRadius * 2 * 1.05) {
        return false;
      }
    }

    cueBall.active = 1;
    cueBall.position = candidate;
    cueBall.velocity = new Vector2D(0, 0);
    return true;
  }

  getTableBounds() {
    const n = 600 * this.config.adjustmentScale;
    const halfW = 50 * n;
    const halfH = 25 * n;
    return {
      left: -halfW + this.config.ballRadius,
      right: halfW - this.config.ballRadius,
      top: -halfH + this.config.ballRadius,
      bottom: halfH - this.config.ballRadius,
    };
  }

  createShotContext() {
    return {
      firstContact: null,
      firstContactTime: null,
      pocketed: new Set(),
      cushionHits: new Set(),
      cueScratch: false,
      contactEvents: [],
    };
  }

  onContact(contact, context) {
    const ball = contact.ball;
    const entry = {
      type: contact.collisionType,
      target: contact.target,
      time: contact.time,
    };
    ball.contactArray.push(entry);
    context.contactEvents.push(entry);

    if (contact.collisionType === 'ball') {
      if (ball.id === 0 && context.firstContact === null) {
        context.firstContact = contact.target.id;
        context.firstContactTime = contact.time;
      }
    }

    if (contact.collisionType === 'line' || contact.collisionType === 'vertex') {
      context.cushionHits.add(ball.id);
    }

    if (contact.collisionType === 'pocket') {
      ball.active = 0;
      ball.velocity = new Vector2D(0, 0);
      if (ball.id === 0) {
        context.cueScratch = true;
        this.state.scratched = true;
      } else {
        context.pocketed.add(ball.id);
        this.state.pottedBallIds.push(ball.id);
      }
    }
  }

  buildShotResult(context) {
    const firstContactTime = context.firstContactTime ?? 0;
    const railAfter = context.contactEvents.some(
      (event) =>
        (event.type === 'line' || event.type === 'vertex') &&
        event.time >= firstContactTime
    );

    return {
      firstContact: context.firstContact,
      pocketed: Array.from(context.pocketed),
      cushionHits: context.cushionHits,
      cueScratch: context.cueScratch,
      ballsOffTable: [],
      railContactAfterFirstHit: railAfter,
    };
  }

  areBallsStopped() {
    return this.state.balls.every((ball) => !ball || ball.velocity.magnitude === 0);
  }
}

module.exports = { EightBallEngine };
