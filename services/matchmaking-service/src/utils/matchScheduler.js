const MATCH_READY_TIMEOUT = 120; // 2 minutes
const QUEUE_TIMEOUT = 300; // 5 minutes
let queueProcessing = false;
let readyProcessing = false;
let timeoutProcessing = false;

exports.startMatchScheduler = function(io, prisma) {
  if (!prisma?.matchQueue || !prisma?.match) {
    console.warn('⚠️ Match queue scheduler disabled: required Prisma models are missing');
    return;
  }
  // Check for players in queue and create matches
  setInterval(async () => {
    if (queueProcessing) return;
    queueProcessing = true;
    try {
      await processMatchQueue(io, prisma);
    } finally {
      queueProcessing = false;
    }
  }, 5000); // Check every 5 seconds

  // Check for ready matches that haven't started
  setInterval(async () => {
    if (readyProcessing) return;
    readyProcessing = true;
    try {
      const timeout = new Date(Date.now() - (MATCH_READY_TIMEOUT * 1000));
      
      const timedOutMatches = await prisma.match.findMany({
        where: {
          status: 'ready',
          scheduledTime: {
            lt: timeout
          }
        }
      });

      for (const match of timedOutMatches) {
        // Check if both players are ready
        if (!match.player1Ready || !match.player2Ready) {
          // Cancel match - player(s) didn't ready up
          await prisma.match.update({
            where: { id: match.id },
            data: {
              status: 'cancelled',
              metadata: JSON.stringify({ reason: 'Player did not ready up' })
            }
          });

          // Notify players
          io.to(`match:${match.id}`).emit('match:cancelled', {
            matchId: match.id,
            reason: 'Opponent did not ready up in time'
          });

          console.log(`⚠️ Match cancelled (timeout): ${match.id}`);
        }
      }
    } catch (error) {
      console.error('Match scheduler error:', error);
    } finally {
      readyProcessing = false;
    }
  }, 30000); // Check every 30 seconds

  // Check for queue timeouts
  setInterval(async () => {
    if (timeoutProcessing) return;
    timeoutProcessing = true;
    try {
      const timeout = new Date(Date.now() - (QUEUE_TIMEOUT * 1000));
      
      const timedOutQueue = await prisma.matchQueue.findMany({
        where: {
          status: 'waiting',
          joinedAt: {
            lt: timeout
          }
        }
      });

      for (const entry of timedOutQueue) {
        await prisma.matchQueue.delete({
          where: { id: entry.id }
        });

        // Notify player
        io.to(`player:${entry.playerId}`).emit('queue:timeout', {
          message: 'No match found in time. Please try again.'
        });

        console.log(`⚠️ Queue timeout for player: ${entry.playerId}`);
      }
    } catch (error) {
      console.error('Queue timeout checker error:', error);
    } finally {
      timeoutProcessing = false;
    }
  }, 60000); // Check every minute

  console.log('✓ Match scheduler started');
}

// Process match queue and create matches
async function processMatchQueue(io, prisma) {
  try {
    // Get all active tournament rounds with players waiting
    const rounds = await prisma.matchQueue.groupBy({
      by: ['tournamentId', 'seasonId', 'round'],
      where: {
        status: 'waiting'
      },
      _count: {
        playerId: true
      }
    });

    for (const round of rounds) {
      const { tournamentId, seasonId, round: roundNumber } = round;
      const playerCount = round._count.playerId;

      // Need at least 2 players to create a match
      if (playerCount >= 2) {
        await createMatchesForRound(io, prisma, tournamentId, seasonId, roundNumber);
      }
    }
  } catch (error) {
    console.error('Process match queue error:', error);
  }
}

// Create all matches for a specific round
async function createMatchesForRound(io, prisma, tournamentId, seasonId, round) {
  try {
    // Get all players waiting in this round
    const waitingPlayers = await prisma.matchQueue.findMany({
      where: {
        tournamentId,
        seasonId,
        round,
        status: 'waiting'
      },
      orderBy: {
        joinedAt: 'asc'
      }
    });

    if (waitingPlayers.length < 2) {
      return;
    }

    // Pair players: [0,1], [2,3], [4,5], etc.
    const matchesCreated = [];
    const scheduledTime = new Date(Date.now() + 10000); // 10 seconds from now

    for (let i = 0; i < waitingPlayers.length - 1; i += 2) {
      const player1 = waitingPlayers[i];
      const player2 = waitingPlayers[i + 1];

      const matchId = player1.id + '-' + player2.id + '-' + Date.now();

      await prisma.matches.create({
        data: {
          id: matchId,
          tournamentId,
          seasonId,
          round,
          player1Id: player1.playerId,
          player2Id: player2.playerId,
          status: 'ready',
          scheduledTime
        }
      });

      matchesCreated.push({
        matchId,
        player1Id: player1.playerId,
        player2Id: player2.playerId
      });
    }

    // Update queue entries to matched status
    const queueEntryIds = waitingPlayers.slice(0, matchesCreated.length * 2).map(p => p.id);
    await prisma.matchQueue.updateMany({
      where: {
        id: { in: queueEntryIds }
      },
      data: {
        status: 'matched',
        matchedAt: new Date()
      }
    });

    // Notify all matched players
    for (const match of matchesCreated) {
      // Notify player 1
      io.to(`player:${match.player1Id}`).emit('match:found', {
        matchId: match.matchId,
        opponentId: match.player2Id,
        scheduledTime,
        round,
        tournamentId
      });

      // Notify player 2
      io.to(`player:${match.player2Id}`).emit('match:found', {
        matchId: match.matchId,
        opponentId: match.player1Id,
        scheduledTime,
        round,
        tournamentId
      });

      console.log(`✓ Match created: ${match.matchId} - ${match.player1Id} vs ${match.player2Id}`);
    }

    // Handle odd number of players (bye)
    if (waitingPlayers.length % 2 === 1) {
      const byePlayer = waitingPlayers[waitingPlayers.length - 1];
      
      io.to(`player:${byePlayer.playerId}`).emit('match:bye', {
        tournamentId,
        seasonId,
        round,
        message: 'You have received a bye and will advance to the next round'
      });

      console.log(`✓ Bye given to player: ${byePlayer.playerId}`);
    }

    console.log(`✓ Created ${matchesCreated.length} match(es) for tournament ${tournamentId} round ${round}`);
  } catch (error) {
    console.error('Create matches for round error:', error);
  }
}
