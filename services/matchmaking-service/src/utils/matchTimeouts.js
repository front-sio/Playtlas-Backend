const { completeMatchAndProgress, evaluateSeasonCompletion } = require('../controllers/matchmakingController');

const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.MATCH_DURATION_SECONDS || 300);
const MATCH_TIMEOUT_CHECK_INTERVAL = Number(process.env.MATCH_TIMEOUT_CHECK_INTERVAL || 15000);
let timeoutScanInFlight = false;

function buildCancelMetadata(reason, winnerId) {
  return {
    reason,
    winnerId: winnerId || null,
    endedAt: new Date().toISOString()
  };
}

function buildTimeoutMetadata(match, resolution) {
  const existing = match.metadata && typeof match.metadata === 'object'
    ? match.metadata
    : {};
  return {
    ...existing,
    timeout: {
      reason: 'match_timeout',
      resolution,
      endedAt: new Date().toISOString()
    }
  };
}

function resolveTimeoutWinner(match) {
  const player1Score = Number(match.player1Score || 0);
  const player2Score = Number(match.player2Score || 0);

  if (player1Score > player2Score) {
    return { winnerId: match.player1Id, resolution: 'score' };
  }

  if (player2Score > player1Score) {
    return { winnerId: match.player2Id, resolution: 'score' };
  }

  const player1Time = match.player1ConnectionTime ? new Date(match.player1ConnectionTime).getTime() : null;
  const player2Time = match.player2ConnectionTime ? new Date(match.player2ConnectionTime).getTime() : null;

  if (player1Time && player2Time && player1Time !== player2Time) {
    return {
      winnerId: player1Time <= player2Time ? match.player1Id : match.player2Id,
      resolution: 'connection_time'
    };
  }

  if (player1Time && !player2Time) {
    return { winnerId: match.player1Id, resolution: 'connection_time' };
  }

  if (!player1Time && player2Time) {
    return { winnerId: match.player2Id, resolution: 'connection_time' };
  }

  return { winnerId: match.player1Id, resolution: 'default' };
}

async function handleTimeout(io, prisma, match) {
  const player1Ready = Boolean(match.player1Ready);
  const player2Ready = Boolean(match.player2Ready);

  if (player1Ready && !player2Ready) {
    await completeMatchAndProgress({
      matchId: match.matchId,
      winnerId: match.player1Id,
      player1Score: Number(match.player1Score || 0),
      player2Score: Number(match.player2Score || 0)
    });
    io.to(`match:${match.matchId}`).emit('match:completed', {
      matchId: match.matchId,
      winnerId: match.player1Id,
      reason: 'opponent_no_show'
    });
    return;
  }

  if (player2Ready && !player1Ready) {
    await completeMatchAndProgress({
      matchId: match.matchId,
      winnerId: match.player2Id,
      player1Score: Number(match.player1Score || 0),
      player2Score: Number(match.player2Score || 0)
    });
    io.to(`match:${match.matchId}`).emit('match:completed', {
      matchId: match.matchId,
      winnerId: match.player2Id,
      reason: 'opponent_no_show'
    });
    return;
  }

  if (player1Ready && player2Ready) {
    const { winnerId, resolution } = resolveTimeoutWinner(match);
    await completeMatchAndProgress({
      matchId: match.matchId,
      winnerId,
      player1Score: Number(match.player1Score || 0),
      player2Score: Number(match.player2Score || 0)
    });
    await prisma.match.update({
      where: { matchId: match.matchId },
      data: {
        metadata: buildTimeoutMetadata(match, resolution)
      }
    });
    io.to(`match:${match.matchId}`).emit('match:completed', {
      matchId: match.matchId,
      winnerId,
      reason: 'match_timeout'
    });
    return;
  }

  try {
    await prisma.match.update({
      where: { matchId: match.matchId },
      data: {
        status: 'cancelled',
        metadata: buildCancelMetadata('match_timeout')
      }
    });

    io.to(`match:${match.matchId}`).emit('match:cancelled', {
      matchId: match.matchId,
      reason: 'Match time expired'
    });
    await evaluateSeasonCompletion(match);
  } catch (error) {
    console.error('[matchTimeouts] Error in handleTimeout:', error);
  }
}

function startMatchTimeoutMonitor(io, prisma) {
  if (!prisma?.match) {
    console.warn('⚠️ Match timeout monitor disabled: prisma.match not available');
    return;
  }

  setInterval(async () => {
    if (timeoutScanInFlight) return;
    timeoutScanInFlight = true;
    try {
      const now = Date.now();
      const candidates = await prisma.match.findMany({
        where: {
          status: { in: ['scheduled', 'ready', 'in_progress'] },
          scheduledTime: { not: null }
        },
        take: 200
      });

      for (const match of candidates) {
        const matchDurationSeconds = Number(match?.metadata?.matchDurationSeconds || DEFAULT_MATCH_DURATION_SECONDS);
        const durationMs = matchDurationSeconds * 1000;
        const baseTime = match.startedAt || match.scheduledTime;
        if (!baseTime) continue;
        const endTime = new Date(baseTime).getTime() + durationMs;
        if (now <= endTime) continue;

        // Grace period for scheduled matches (2 minutes)
        if (match.status === 'scheduled') {
          const gracePeriodMs = 2 * 60 * 1000;
          if (now <= endTime + gracePeriodMs) continue;
        }

        if (!match.player1Ready && !match.player2Ready) {
          await prisma.match.update({
            where: { matchId: match.matchId },
            data: {
              status: 'cancelled',
              metadata: buildCancelMetadata('no_players_ready')
            }
          });
          io.to(`match:${match.matchId}`).emit('match:cancelled', {
            matchId: match.matchId,
            reason: 'No players ready'
          });
          await evaluateSeasonCompletion(match);
          continue;
        }

        await handleTimeout(io, prisma, match);
      }
    } catch (error) {
      console.error('[matchTimeouts] Monitor error:', error);
    } finally {
      timeoutScanInFlight = false;
    }
  }, MATCH_TIMEOUT_CHECK_INTERVAL);

  console.log('✓ Match timeout monitor started');
}

module.exports = {
  startMatchTimeoutMonitor
};
