// backend/services/game-service/src/engine/8ball/rules.js
class EightBallRules {
  constructor() {
    this.state = this.getInitialState();
    this.activeBalls = new Set(Array.from({ length: 16 }, (_, i) => i));
  }

  getInitialState() {
    return {
      turn: 'p1',
      p1Target: 'ANY',
      p2Target: 'ANY',
      shotNumber: 0,
      ballInHand: false,
      winner: null,
      foul: false,
      message: 'Break the rack!',
      p1Score: 0,
      p2Score: 0,
      p1BallsRemaining: 7,
      p2BallsRemaining: 7,
      currentRun: 0,
      gameStats: {
        totalShots: 0,
        p1ConsecutiveWins: 0,
        p2ConsecutiveWins: 0,
        longestRun: 0,
        p1Fouls: 0,
        p2Fouls: 0,
      },
      lastShotResult: '',
      foulType: null,
      breakComplete: false,
    };
  }

  getState() {
    return { ...this.state };
  }

  setState(state) {
    this.state = { ...this.state, ...state };
  }

  updateActiveBalls(activeBallIds) {
    this.activeBalls = new Set(activeBallIds);
  }

  resetGame() {
    this.state = this.getInitialState();
    this.activeBalls = new Set(Array.from({ length: 16 }, (_, i) => i));
  }

  evaluateShot(shotResult) {
    const { turn, p1Target, p2Target, shotNumber, breakComplete } = this.state;
    const opponent = turn === 'p1' ? 'p2' : 'p1';
    const playerTarget = turn === 'p1' ? p1Target : p2Target;

    this.state.shotNumber++;
    this.state.gameStats.totalShots++;
    this.state.foul = false;
    this.state.foulType = null;
    this.state.lastShotResult = '';

    let continueTurn = false;
    let foulOccurred = false;
    let message = '';

    if (shotNumber === 0) {
      return this.evaluateBreak(shotResult);
    }

    const foulCheck = this.checkForFouls(shotResult, playerTarget);
    if (foulCheck.isFoul) {
      foulOccurred = true;
      this.state.foul = true;
      this.state.foulType = foulCheck.foulType;
      message = foulCheck.message;

      if (turn === 'p1') {
        this.state.gameStats.p1Fouls++;
      } else {
        this.state.gameStats.p2Fouls++;
      }
    }

    if (shotResult.pocketed.includes(8)) {
      return this.handle8BallPocket(shotResult, playerTarget, foulOccurred);
    }

    if (!foulOccurred && playerTarget === 'ANY' && shotResult.pocketed.length > 0 && breakComplete) {
      const assignment = this.assignGroups(shotResult.pocketed, turn);
      if (assignment.success) {
        message = assignment.message;
        this.state.lastShotResult = 'Group assigned';
      } else if (assignment.foul) {
        foulOccurred = true;
        this.state.foul = true;
        message = assignment.message;
      }
    }

    if (!foulOccurred && shotResult.pocketed.length > 0) {
      const legalBalls = this.countLegalBalls(shotResult.pocketed, playerTarget);
      if (legalBalls > 0) {
        continueTurn = true;
        this.state.currentRun++;
        if (this.state.currentRun > this.state.gameStats.longestRun) {
          this.state.gameStats.longestRun = this.state.currentRun;
        }
        if (turn === 'p1') {
          this.state.p1Score += legalBalls;
        } else {
          this.state.p2Score += legalBalls;
        }
        message = `${legalBalls} ball${legalBalls > 1 ? 's' : ''} pocketed`;
        this.state.lastShotResult = 'Legal pocket';

        const remaining = this.getPlayerBallsRemaining(turn);
        if (remaining === 0 && playerTarget !== 'ANY') {
          this.state[turn === 'p1' ? 'p1Target' : 'p2Target'] = '8';
          message = 'All your balls cleared! Sink the 8-ball to win!';
          this.state.lastShotResult = 'Group cleared';
        }
      } else if (shotResult.pocketed.length > 0) {
        message = 'Opponent ball pocketed - turn ends';
        this.state.lastShotResult = 'Opponent ball';
      }
    }

    this.state.p1BallsRemaining = this.getPlayerBallsRemaining('p1');
    this.state.p2BallsRemaining = this.getPlayerBallsRemaining('p2');

    if (foulOccurred) {
      this.state.turn = opponent;
      this.state.ballInHand = true;
      this.state.currentRun = 0;
    } else if (continueTurn) {
      this.state.ballInHand = false;
    } else {
      this.state.turn = opponent;
      this.state.ballInHand = false;
      this.state.currentRun = 0;
    }

    this.state.message = message || 'Shot complete';
    return this.getState();
  }

  evaluateBreak(shotResult) {
    let validBreak = false;
    let message = '';

    const ballsHitCushion = shotResult.cushionHits.size;
    const ballsPocketed = shotResult.pocketed.length;

    if (ballsPocketed > 0 || ballsHitCushion >= 4) {
      validBreak = true;
    }

    if (!validBreak) {
      this.state.foul = true;
      this.state.foulType = 'ILLEGAL_BREAK';
      this.state.ballInHand = true;
      this.state.message = 'Illegal break - less than 4 balls hit cushions';
      this.state.turn = this.state.turn === 'p1' ? 'p2' : 'p1';
      return this.getState();
    }

    this.state.breakComplete = true;
    this.state.message = 'Break shot complete';

    if (shotResult.cueScratch) {
      this.state.foul = true;
      this.state.foulType = 'SCRATCH';
      this.state.ballInHand = true;
      this.state.turn = this.state.turn === 'p1' ? 'p2' : 'p1';
    }

    return this.getState();
  }

  checkForFouls(shotResult, playerTarget) {
    const { firstContact, cueScratch, railContactAfterFirstHit } = shotResult;

    if (firstContact === null) {
      return { isFoul: true, foulType: 'NO_CONTACT', message: 'No ball contacted' };
    }

    if (cueScratch) {
      return { isFoul: true, foulType: 'SCRATCH', message: 'Cue ball scratched' };
    }

    if (playerTarget !== 'ANY' && playerTarget !== '8') {
      if (playerTarget === 'SOLIDS' && firstContact > 8) {
        return { isFoul: true, foulType: 'WRONG_BALL_FIRST', message: 'Wrong ball struck first' };
      }
      if (playerTarget === 'STRIPES' && firstContact < 9 && firstContact !== 0) {
        return { isFoul: true, foulType: 'WRONG_BALL_FIRST', message: 'Wrong ball struck first' };
      }
    }

    if (!railContactAfterFirstHit && shotResult.pocketed.length === 0) {
      return { isFoul: true, foulType: 'NO_RAIL_AFTER_CONTACT', message: 'No rail contact after hit' };
    }

    return { isFoul: false, foulType: null, message: '' };
  }

  handle8BallPocket(shotResult, playerTarget, foulOccurred) {
    if (foulOccurred) {
      this.state.winner = this.state.turn === 'p1' ? 'p2' : 'p1';
      this.state.message = '8-ball sunk on a foul - you lose';
      return this.getState();
    }

    if (playerTarget !== '8') {
      this.state.winner = this.state.turn === 'p1' ? 'p2' : 'p1';
      this.state.message = '8-ball sunk early - you lose';
      this.state.foulType = 'EIGHT_BALL_EARLY';
      return this.getState();
    }

    this.state.winner = this.state.turn;
    this.state.message = '8-ball sunk - you win!';
    return this.getState();
  }

  assignGroups(pocketedBalls, turn) {
    const solidPocketed = pocketedBalls.some((ball) => ball > 0 && ball < 8);
    const stripePocketed = pocketedBalls.some((ball) => ball > 8);

    if (solidPocketed && stripePocketed) {
      return {
        success: false,
        foul: true,
        message: 'Cannot assign groups when both types are pocketed',
      };
    }

    const group = solidPocketed ? 'SOLIDS' : 'STRIPES';
    if (turn === 'p1') {
      this.state.p1Target = group;
      this.state.p2Target = group === 'SOLIDS' ? 'STRIPES' : 'SOLIDS';
    } else {
      this.state.p2Target = group;
      this.state.p1Target = group === 'SOLIDS' ? 'STRIPES' : 'SOLIDS';
    }

    return { success: true, foul: false, message: `${group} assigned` };
  }

  countLegalBalls(pocketedBalls, playerTarget) {
    if (playerTarget === 'ANY') {
      return pocketedBalls.filter((ball) => ball !== 8).length;
    }
    if (playerTarget === 'SOLIDS') {
      return pocketedBalls.filter((ball) => ball > 0 && ball < 8).length;
    }
    if (playerTarget === 'STRIPES') {
      return pocketedBalls.filter((ball) => ball > 8).length;
    }
    return 0;
  }

  getPlayerBallsRemaining(player) {
    const target = player === 'p1' ? this.state.p1Target : this.state.p2Target;
    let count = 0;
    for (const ball of this.activeBalls) {
      if (ball === 0 || ball === 8) continue;
      if (target === 'SOLIDS' && ball < 8) count++;
      if (target === 'STRIPES' && ball > 8) count++;
      if (target === 'ANY') count++;
    }
    return count;
  }
}

module.exports = { EightBallRules };
