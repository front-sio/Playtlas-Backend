const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { publishEvent, Topics } = require('../../../../shared/events');
const SeasonMatchmakingController = require('./seasonMatchmakingController');
const { createMatches } = require('./matchCreationController');
const { getIO } = require('../utils/socket');

const prisma = new PrismaClient();
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'http://localhost:3006';

const GROUP_QUALIFIERS = Number(process.env.GROUP_QUALIFIERS || 2);

const BYE_PLAYER_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.MATCH_DURATION_SECONDS || 300);
const MATCH_VERIFICATION_TTL_SECONDS = Number(process.env.MATCH_VERIFICATION_TTL_SECONDS || 90);

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const buildVerificationToken = () =>
  crypto.randomBytes(32).toString('base64url');

const buildBleNonce = () =>
  crypto.randomBytes(16).toString('base64url');

function getInitialStage(playerCount) {
  if (playerCount <= 1) return null;
  const bracketSize = 2 ** Math.ceil(Math.log2(playerCount));
  if (bracketSize <= 2) return 'final';
  if (bracketSize <= 4) return 'semifinal';
  if (bracketSize <= 8) return 'quarterfinal';
  if (bracketSize <= 16) return 'round_of_16';
  return `round_of_${bracketSize}`;
}

function getNextStage(stage) {
  const normalized = String(stage || '').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'quarterfinal') return 'semifinal';
  if (normalized === 'semifinal') return 'third_place';
  if (normalized === 'third_place') return 'final';
  if (normalized === 'final') return null;
  if (normalized === 'round_of_16') return 'quarterfinal';
  if (normalized.startsWith('round_of_')) {
    const count = Number(normalized.replace('round_of_', ''));
    if (!Number.isFinite(count) || count <= 0) return null;
    if (count <= 16) return 'quarterfinal';
    const nextCount = Math.floor(count / 2);
    if (nextCount <= 16) return 'round_of_16';
    return `round_of_${nextCount}`;
  }
  return null;
}

function isBracketStage(stage) {
  const normalized = String(stage || '').toLowerCase();
  if (!normalized) return false;
  if (normalized === 'final' || normalized === 'third_place' || normalized === 'semifinal' || normalized === 'quarterfinal') {
    return true;
  }
  return normalized.startsWith('round_of_');
}

function getStageRank(stage) {
  const normalized = String(stage || '').toLowerCase();
  if (!normalized) return 9999;
  if (normalized.startsWith('round_of_')) {
    const count = Number(normalized.replace('round_of_', ''));
    if (Number.isFinite(count)) {
      return 1000 - count;
    }
  }
  if (normalized === 'quarterfinal') return 1100;
  if (normalized === 'semifinal') return 1200;
  if (normalized === 'third_place') return 1300;
  if (normalized === 'final') return 1400;
  return 9999;
}

function isByeMatch(match) {
  return match?.metadata?.bye === true || match?.player2Id === BYE_PLAYER_ID;
}

function getMatchLoser(match) {
  if (!match?.winnerId) return null;
  if (match.player1Id === match.winnerId) return match.player2Id;
  if (match.player2Id === match.winnerId) return match.player1Id;
  return null;
}

function getOpponentId(match, hostId) {
  if (!match) return null;
  if (match.player1Id === hostId) return match.player2Id;
  if (match.player2Id === hostId) return match.player1Id;
  return null;
}

exports.issueHostVerification = async (req, res) => {
  try {
    const { matchId } = req.params;
    const requesterId = req.user?.userId;
    const requesterRole = String(req.user?.role || '').toLowerCase();

    if (!requesterId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const match = await prisma.match.findUnique({ where: { matchId } });
    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    const isService = requesterRole === 'service';
    if (!isService && match.assignedHostPlayerUserId !== requesterId) {
      return res.status(403).json({ success: false, error: 'Only the assigned host can start verification' });
    }

    if (['completed', 'cancelled'].includes(match.status)) {
      return res.status(400).json({ success: false, error: `Match is ${match.status}` });
    }

    const opponentId = getOpponentId(match, match.assignedHostPlayerUserId);
    if (!opponentId) {
      return res.status(400).json({ success: false, error: 'Match does not have a valid opponent' });
    }

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + MATCH_VERIFICATION_TTL_SECONDS * 1000);
    const token = buildVerificationToken();
    const tokenHash = hashToken(token);
    const bleNonce = buildBleNonce();

    await prisma.matchVerification.updateMany({
      where: { matchId, status: 'issued' },
      data: { status: 'revoked' }
    });

    const verification = await prisma.matchVerification.create({
      data: {
        matchId,
        hostUserId: match.assignedHostPlayerUserId,
        opponentUserId: opponentId,
        opponentSessionId: req.body?.opponentSessionId || null,
        tokenHash,
        bleNonce,
        expiresAt
      }
    });

    const metadata = match.metadata && typeof match.metadata === 'object' ? match.metadata : {};
    await prisma.match.update({
      where: { matchId },
      data: {
        verificationStatus: 'qr_issued',
        verificationMethod: 'qr_ble',
        metadata: {
          ...metadata,
          verification: {
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            verificationId: verification.verificationId
          }
        }
      }
    });

    const io = getIO();
    if (io) {
      io.to(`player:${opponentId}`).emit('match:verification_qr', {
        matchId,
        token,
        expiresAt: expiresAt.toISOString(),
        bleNonce
      });
    }

    return res.json({
      success: true,
      data: {
        matchId,
        expiresAt: expiresAt.toISOString()
      }
    });
  } catch (error) {
    logger.error({ err: error }, '[matchmaking] Failed to issue verification QR');
    return res.status(500).json({ success: false, error: 'Failed to issue verification QR' });
  }
};

exports.verifyHostQr = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { token, bleNonce } = req.body || {};
    const requesterId = req.user?.userId;
    const requesterRole = String(req.user?.role || '').toLowerCase();

    if (!requesterId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!token) {
      return res.status(400).json({ success: false, error: 'token is required' });
    }

    const match = await prisma.match.findUnique({ where: { matchId } });
    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    const isService = requesterRole === 'service';
    if (!isService && match.assignedHostPlayerUserId !== requesterId) {
      return res.status(403).json({ success: false, error: 'Only the assigned host can verify' });
    }

    const opponentId = getOpponentId(match, match.assignedHostPlayerUserId);
    if (!opponentId) {
      return res.status(400).json({ success: false, error: 'Match does not have a valid opponent' });
    }

    const tokenHash = hashToken(token);
    const verification = await prisma.matchVerification.findFirst({
      where: {
        matchId,
        hostUserId: match.assignedHostPlayerUserId,
        opponentUserId: opponentId,
        tokenHash,
        status: 'issued'
      }
    });

    if (!verification) {
      return res.status(400).json({ success: false, error: 'Invalid or already used token' });
    }

    if (verification.expiresAt <= new Date()) {
      await prisma.matchVerification.update({
        where: { verificationId: verification.verificationId },
        data: { status: 'expired' }
      });
      return res.status(400).json({ success: false, error: 'Token expired' });
    }

    if (match.verificationMethod === 'qr_ble' && !bleNonce) {
      return res.status(400).json({ success: false, error: 'BLE nonce is required' });
    }

    if (bleNonce && verification.bleNonce && bleNonce !== verification.bleNonce) {
      return res.status(400).json({ success: false, error: 'BLE verification failed' });
    }

    await prisma.matchVerification.update({
      where: { verificationId: verification.verificationId },
      data: { status: 'consumed', consumedAt: new Date() }
    });

    const metadata = match.metadata && typeof match.metadata === 'object' ? match.metadata : {};
    const verifiedAt = new Date();
    const updatedMatch = await prisma.match.update({
      where: { matchId },
      data: {
        verificationStatus: 'verified',
        verifiedAt,
        metadata: {
          ...metadata,
          verification: {
            ...(metadata.verification || {}),
            verifiedAt: verifiedAt.toISOString()
          }
        }
      }
    });

    const io = getIO();
    if (io) {
      io.to(`match:${matchId}`).emit('match:verified', {
        matchId,
        verifiedAt: verifiedAt.toISOString()
      });
    }

    return res.json({ success: true, data: updatedMatch });
  } catch (error) {
    logger.error({ err: error }, '[matchmaking] Failed to verify host QR');
    return res.status(500).json({ success: false, error: 'Failed to verify host QR' });
  }
};

function getMatchDurationSeconds(match) {
  return Number(match?.metadata?.matchDurationSeconds || DEFAULT_MATCH_DURATION_SECONDS);
}

async function assignWinnerAdvances(roundMatches, nextMatches) {
  if (!roundMatches.length || !nextMatches.length) return;
  await Promise.all(
    roundMatches.map((roundMatch, index) => {
      const nextMatch = nextMatches[Math.floor(index / 2)];
      if (!nextMatch) return null;
      return prisma.match.update({
        where: { matchId: roundMatch.matchId },
        data: {
          winnerAdvancesToMatchId: nextMatch.matchId,
          winnerAdvancesToSlot: index % 2 === 0 ? 'A' : 'B'
        }
      });
    }).filter(Boolean)
  );
}

async function emitRoundMatches(tournamentId, seasonId, stage, roundNumber, matches) {
  const io = getIO();
  if (!io) return;
  const payload = {
    tournamentId,
    seasonId,
    stage,
    roundNumber,
    matches
  };
  io.to(`season:${seasonId}`).emit('season:matches_generated', payload);
  io.to(`tournament:${tournamentId}`).emit('season:matches_generated', payload);
}

async function progressTournament(match) {
  if (!match?.seasonId || !match?.tournamentId) return;

  if (match.stage === 'group') {
    const groupMatches = await prisma.match.findMany({
      where: {
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        stage: 'group'
      },
      orderBy: { createdAt: 'asc' }
    });

    if (!groupMatches.length || groupMatches.some((m) => m.status !== 'completed')) {
      return;
    }

    const standingsByGroup = new Map();

    for (const m of groupMatches) {
      const groupId = m.metadata?.groupId || 'group';
      if (!standingsByGroup.has(groupId)) {
        standingsByGroup.set(groupId, new Map());
      }
      const groupStats = standingsByGroup.get(groupId);

      const ensurePlayer = (playerId) => {
        if (!groupStats.has(playerId)) {
          groupStats.set(playerId, { wins: 0, scoreDiff: 0 });
        }
      };

      ensurePlayer(m.player1Id);
      ensurePlayer(m.player2Id);

      const player1Stats = groupStats.get(m.player1Id);
      const player2Stats = groupStats.get(m.player2Id);
      const player1Score = Number(m.player1Score || 0);
      const player2Score = Number(m.player2Score || 0);

      player1Stats.scoreDiff += player1Score - player2Score;
      player2Stats.scoreDiff += player2Score - player1Score;

      if (m.winnerId === m.player1Id) {
        player1Stats.wins += 1;
      } else if (m.winnerId === m.player2Id) {
        player2Stats.wins += 1;
      }
    }

    const qualifiers = [];
    for (const [groupId, groupStats] of standingsByGroup.entries()) {
      const sorted = Array.from(groupStats.entries())
        .map(([playerId, stats]) => ({ playerId, ...stats }))
        .sort((a, b) => {
          if (b.wins !== a.wins) return b.wins - a.wins;
          if (b.scoreDiff !== a.scoreDiff) return b.scoreDiff - a.scoreDiff;
          return a.playerId.localeCompare(b.playerId);
        });
      const takeCount = Math.min(GROUP_QUALIFIERS, sorted.length);
      qualifiers.push(...sorted.slice(0, takeCount).map((entry) => entry.playerId));
      logger.info('Group standings resolved', { groupId, qualifiers: sorted.slice(0, takeCount) });
    }

    const uniqueQualifiers = Array.from(new Set(qualifiers));
    if (uniqueQualifiers.length < 2) return;

    const nextStage = getInitialStage(uniqueQualifiers.length);
    const existingNext = await prisma.match.findFirst({
      where: {
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        stage: nextStage,
        roundNumber: 1
      }
    });
    if (existingNext) return;

    const nextMatches = await createMatches(uniqueQualifiers, {
      tournamentId: match.tournamentId,
      seasonId: match.seasonId,
      stage: nextStage,
      roundNumber: 1,
      matchDurationSeconds: getMatchDurationSeconds(match),
      clubId: match.clubId || null
    });

    await emitRoundMatches(match.tournamentId, match.seasonId, nextStage, 1, nextMatches);
    return;
  }

  const roundMatches = await prisma.match.findMany({
    where: {
      tournamentId: match.tournamentId,
      seasonId: match.seasonId,
      stage: match.stage,
      roundNumber: match.roundNumber
    },
    orderBy: { createdAt: 'asc' }
  });

  if (!roundMatches.length || roundMatches.some((m) => m.status !== 'completed')) {
    return;
  }

  if (match.stage === 'final') {
    return;
  }

  if (match.stage === 'third_place') {
    const finalExists = await prisma.match.findFirst({
      where: {
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        stage: 'final'
      }
    });
    if (finalExists) return;

    const semifinalMatches = await prisma.match.findMany({
      where: {
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        stage: 'semifinal'
      }
    });

    const finalists = semifinalMatches
      .map((m) => m.winnerId)
      .filter((id) => typeof id === 'string' && id.length > 0);

    if (finalists.length < 2) return;

    const finalMatches = await createMatches(finalists.slice(0, 2), {
      tournamentId: match.tournamentId,
      seasonId: match.seasonId,
      stage: 'final',
      roundNumber: match.roundNumber,
      matchDurationSeconds: getMatchDurationSeconds(match),
      clubId: match.clubId || null
    });
    await emitRoundMatches(match.tournamentId, match.seasonId, 'final', match.roundNumber, finalMatches);
    return;
  }

  if (match.stage === 'semifinal') {
    const winners = roundMatches
      .map((m) => m.winnerId)
      .filter((id) => typeof id === 'string' && id.length > 0);

    const losers = roundMatches
      .filter((m) => !isByeMatch(m))
      .map((m) => getMatchLoser(m))
      .filter((id) => typeof id === 'string' && id.length > 0);

    if (losers.length >= 2) {
      const thirdPlaceExists = await prisma.match.findFirst({
        where: {
          tournamentId: match.tournamentId,
          seasonId: match.seasonId,
          stage: 'third_place'
        }
      });
      if (!thirdPlaceExists) {
        const thirdMatches = await createMatches(losers.slice(0, 2), {
          tournamentId: match.tournamentId,
          seasonId: match.seasonId,
          stage: 'third_place',
          roundNumber: match.roundNumber + 1,
          matchDurationSeconds: getMatchDurationSeconds(match),
          clubId: match.clubId || null
        });
        await emitRoundMatches(match.tournamentId, match.seasonId, 'third_place', match.roundNumber + 1, thirdMatches);
      }
    }

    if (winners.length >= 2) {
      const finalExists = await prisma.match.findFirst({
        where: {
          tournamentId: match.tournamentId,
          seasonId: match.seasonId,
          stage: 'final'
        }
      });
      if (finalExists) return;

      const finalMatches = await createMatches(winners.slice(0, 2), {
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        stage: 'final',
        roundNumber: match.roundNumber + 1,
        matchDurationSeconds: getMatchDurationSeconds(match),
        clubId: match.clubId || null
      });
      await assignWinnerAdvances(roundMatches, finalMatches);
      await emitRoundMatches(match.tournamentId, match.seasonId, 'final', match.roundNumber + 1, finalMatches);
    }
    return;
  }

  const nextStage = getNextStage(match.stage);
  if (!nextStage) return;

  const existingNext = await prisma.match.findFirst({
    where: {
      tournamentId: match.tournamentId,
      seasonId: match.seasonId,
      stage: nextStage,
      roundNumber: match.roundNumber + 1
    }
  });
  if (existingNext) return;

  const winners = roundMatches
    .map((m) => m.winnerId)
    .filter((id) => typeof id === 'string' && id.length > 0);

  if (winners.length < 2) return;

  const nextMatches = await createMatches(winners, {
    tournamentId: match.tournamentId,
    seasonId: match.seasonId,
    stage: nextStage,
    roundNumber: match.roundNumber + 1,
    matchDurationSeconds: getMatchDurationSeconds(match),
    clubId: match.clubId || null
  });

  await assignWinnerAdvances(roundMatches, nextMatches);
  await emitRoundMatches(match.tournamentId, match.seasonId, nextStage, match.roundNumber + 1, nextMatches);
}

async function evaluateSeasonCompletion(match) {
  if (!match?.seasonId || !match?.tournamentId) return;
  if (!global.seasonCompletionTimers) {
    global.seasonCompletionTimers = new Map();
  }
  const seasonCompletionTimers = global.seasonCompletionTimers;
  const completionDelayMs = 30000;

  // Check if any matches are still pending for this season
  const pendingMatches = await prisma.match.findMany({
    where: {
      tournamentId: match.tournamentId,
      seasonId: match.seasonId,
      status: { in: ['scheduled', 'ready', 'in_progress'] }
    }
  });

  if (pendingMatches.length > 0) {
    const existingTimer = seasonCompletionTimers.get(match.seasonId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      seasonCompletionTimers.delete(match.seasonId);
    }
    logger.info({ seasonId: match.seasonId, pendingCount: pendingMatches.length }, '[matchmaking] Season not yet complete, matches pending');
    return;
  }

  if (seasonCompletionTimers.has(match.seasonId)) {
    logger.info({ seasonId: match.seasonId }, '[matchmaking] Season completion already scheduled');
    return;
  }

  const timer = setTimeout(async () => {
    try {
      const finalMatch = await prisma.match.findFirst({
        where: {
          tournamentId: match.tournamentId,
          seasonId: match.seasonId,
          stage: 'final',
          status: 'completed'
        }
      });

      let stillPending = await prisma.match.findMany({
        where: {
          tournamentId: match.tournamentId,
          seasonId: match.seasonId,
          status: { in: ['scheduled', 'ready', 'in_progress'] }
        }
      });
      if (stillPending.length > 0) {
        const thirdPlaceOnly = finalMatch && stillPending.every(({ stage }) => stage === 'third_place');
        if (thirdPlaceOnly) {
          await Promise.all(
            stillPending.map((pendingMatch) =>
              prisma.match.update({
                where: { matchId: pendingMatch.matchId },
                data: {
                  status: 'cancelled',
                  metadata: {
                    ...(pendingMatch.metadata || {}),
                    finalizedWithoutThirdPlace: true,
                    finalizationReason: 'third_place_skipped'
                  }
                }
              })
            )
          );
          logger.info(
            { seasonId: match.seasonId, matches: stillPending.map((m) => m.matchId) },
            '[matchmaking] Auto-cancelled pending third-place matches now that final completed'
          );
          stillPending = [];
        }
      }
      if (stillPending.length > 0) {
        logger.info({ seasonId: match.seasonId, pendingCount: stillPending.length }, '[matchmaking] Season completion delayed, matches pending');
        return;
      }

      // Season is complete. Determine placements.
      // finalMatch already loaded above

      // Get all completed matches to determine player count
      const allMatches = await prisma.match.findMany({
        where: {
          tournamentId: match.tournamentId,
          seasonId: match.seasonId,
          status: 'completed'
        }
      });

      // Determine unique players in season
      const uniquePlayers = new Set();
      allMatches.forEach(m => {
        if (m.player1Id) uniquePlayers.add(m.player1Id);
        if (m.player2Id) uniquePlayers.add(m.player2Id);
      });
      const playerCount = uniquePlayers.size;

      let placements = {};
      let isDraw = false;

      if (finalMatch) {
        isDraw = Boolean(finalMatch.metadata?.draw);
        placements = isDraw
          ? {
            draw: true,
            participants: [finalMatch.player1Id, finalMatch.player2Id].filter(Boolean),
            playerCount
          }
          : {
            first: finalMatch.winnerId,
            playerCount
          };
      } else {
        // No final match - likely a 2-player season or single match
        logger.info({ seasonId: match.seasonId, playerCount }, '[matchmaking] No final match found, using last completed match');
        
        // For 2-player seasons, only winner gets prize
        placements = {
          first: match.winnerId,
          playerCount
        };
      }

      await publishEvent(
        Topics.SEASON_COMPLETED,
        {
          tournamentId: match.tournamentId,
          seasonId: match.seasonId,
          status: 'completed',
          endedAt: new Date().toISOString(),
          placements,
          draw: isDraw,
          finalMatchId: finalMatch?.matchId || match.matchId,
          finalizedByJobId: `match_completion:${match.matchId}`
        },
        match.seasonId
      );

      const io = getIO();
      if (io) {
        const payload = {
          tournamentId: match.tournamentId,
          seasonId: match.seasonId,
          placements
        };
        io.to(`season:${match.seasonId}`).emit('season:completed', payload);
        io.to(`tournament:${match.tournamentId}`).emit('season:completed', payload);
      }

      logger.info({ tournamentId: match.tournamentId, seasonId: match.seasonId }, '[matchmaking] Season completion event published');
    } catch (err) {
      logger.error({ err, seasonId: match.seasonId }, '[matchmaking] Season completion scheduling failed');
    } finally {
      seasonCompletionTimers.delete(match.seasonId);
    }
  }, completionDelayMs);

  seasonCompletionTimers.set(match.seasonId, timer);
}

async function completeMatchAndProgress({ matchId, winnerId, player1Score, player2Score, draw, reason, matchDuration, completedAt }) {
  const match = await prisma.match.findUnique({ where: { matchId } });
  if (!match) {
    const err = new Error('Match not found');
    err.statusCode = 404;
    throw err;
  }
  if (match.status === 'completed' && (match.winnerId || match.metadata?.draw)) {
    return match;
  }

  const isDraw = Boolean(draw);
  const metadata = match.metadata && typeof match.metadata === 'object' ? match.metadata : {};
  const loserId = isDraw ? null : (match.player1Id === winnerId ? match.player2Id : match.player1Id);

  const updatedMatch = await prisma.match.update({
    where: { matchId },
    data: {
      winnerId: isDraw ? null : winnerId,
      status: 'completed',
      completedAt: completedAt ? new Date(completedAt) : new Date(),
      player1Score,
      player2Score,
      metadata: {
        ...metadata,
        ...(isDraw ? { draw: true } : {}),
        ...(reason ? { reason } : {}),
        ...(matchDuration != null ? { matchDuration } : {})
      }
    },
  });

  try {
    await publishEvent(Topics.MATCH_COMPLETED, {
      tournamentId: match.tournamentId,
      seasonId: match.seasonId,
      matchId: match.matchId,
      stage: match.stage,
      roundNumber: match.roundNumber,
      winnerId: winnerId,
      loserId: loserId,
      draw: isDraw,
      reason
    });
  } catch (eventErr) {
    logger.error('Failed to publish MATCH_COMPLETED event:', eventErr);
  }

  logger.info(
    { matchId, winnerId, draw: isDraw, reason },
    'Match completed'
  );
  const io = getIO();
  if (io) {
    const payload = {
      matchId,
      winnerId: isDraw ? null : winnerId,
      player1Score,
      player2Score,
      draw: isDraw,
      reason: reason || 'completed',
      completedAt: updatedMatch.completedAt?.toISOString() || new Date().toISOString()
    };
    io.to(`match:${matchId}`).emit('match:completed', payload);
    io.to(`match:${matchId}`).emit('MATCH_COMPLETE', payload);
  }
  await progressTournament(updatedMatch);
  await evaluateSeasonCompletion(updatedMatch);
  try {
    if (updatedMatch.seasonId) {
      await SeasonMatchmakingController.tryCreateMatches(updatedMatch.seasonId);
    }
  } catch (queueErr) {
    logger.error({ err: queueErr, seasonId: updatedMatch.seasonId }, '[matchmaking] Failed to advance season queue');
  }
  return updatedMatch;
}

exports.updateMatchStart = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { startedAt, sessionId, source } = req.body;
    const requesterId = req.user?.userId;
    const requesterRole = String(req.user?.role || '').toLowerCase();

    if (!requesterId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const match = await prisma.match.findUnique({ where: { matchId } });
    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    const isAdmin = ['admin', 'super_admin', 'superuser', 'superadmin', 'manager', 'director', 'staff'].includes(requesterRole);
    const isService = requesterRole === 'service';
    const isHost = match.assignedHostPlayerUserId && match.assignedHostPlayerUserId === requesterId;

    if (!isService && !isAdmin && !isHost) {
      return res.status(403).json({ success: false, error: 'Only the assigned host can start this match' });
    }

    if (!isService && !isAdmin && match.verificationStatus !== 'verified') {
      return res.status(403).json({ success: false, error: 'Match is not verified' });
    }

    if (['completed', 'cancelled'].includes(match.status)) {
      return res.status(400).json({ success: false, error: `Match is ${match.status}` });
    }

    const requestedStart = startedAt ? new Date(startedAt) : new Date();
    if (Number.isNaN(requestedStart.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid startedAt' });
    }

    const existingStart = match.startedAt ? new Date(match.startedAt) : null;
    const shouldUpdateStart = !existingStart || requestedStart > existingStart;
    const effectiveStart = shouldUpdateStart ? requestedStart : existingStart;

    const metadata = match.metadata && typeof match.metadata === 'object' ? match.metadata : {};
    const updateData = {};
    if (shouldUpdateStart) {
      updateData.startedAt = effectiveStart;
    }
    if (match.status === 'scheduled' || match.status === 'ready') {
      updateData.status = 'in_progress';
    }
    if (source) {
      updateData.metadata = {
        ...metadata,
        startSource: source,
        startSignalAt: new Date().toISOString()
      };
    }

    const updatedMatch = Object.keys(updateData).length
      ? await prisma.match.update({ where: { matchId }, data: updateData })
      : match;

    const targetSessionId = sessionId || updatedMatch.gameSessionId;
    if (targetSessionId) {
      try {
        await axios.post(`${GAME_SERVICE_URL}/sessions/${targetSessionId}/start`, {
          startedAt: effectiveStart.toISOString()
        });
      } catch (error) {
        logger.warn({ err: error, matchId, sessionId: targetSessionId }, '[matchmaking] Failed to sync session start');
      }
    }

    const io = getIO();
    if (io) {
      const maxDurationSeconds = Number(updatedMatch?.metadata?.matchDurationSeconds || 300);
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - effectiveStart.getTime()) / 1000));
      const remainingSeconds = Math.max(0, maxDurationSeconds - elapsedSeconds);

      io.to(`match:${matchId}`).emit('match:started', {
        matchId,
        gameSessionId: updatedMatch.gameSessionId || null,
        startedAt: effectiveStart.toISOString(),
        maxDurationSeconds
      });

      io.to(`match:${matchId}`).emit('match:timing_info', {
        matchId,
        startedAt: effectiveStart.toISOString(),
        elapsedSeconds,
        remainingSeconds,
        maxDurationSeconds
      });
    }

    res.json({ success: true, data: updatedMatch });
  } catch (error) {
    logger.error({ err: error }, '[matchmaking] Failed to update match start');
    res.status(500).json({ success: false, error: 'Failed to update match start' });
  }
};

exports.updateMatchResult = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { winnerId, player1Score, player2Score, draw, reason: rawReason, endReason, matchDuration, completedAt } = req.body;
    const reason = rawReason || endReason || 'completed';
    const matchDurationSeconds = matchDuration == null
      ? undefined
      : (Number.isFinite(Number(matchDuration)) ? Number(matchDuration) : undefined);
    const parsedPlayer1Score = Number.isFinite(Number(player1Score)) ? Number(player1Score) : null;
    const parsedPlayer2Score = Number.isFinite(Number(player2Score)) ? Number(player2Score) : null;
    const requesterId = req.user?.userId;
    const requesterRole = String(req.user?.role || '').toLowerCase();

    if (!requesterId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const match = await prisma.match.findUnique({ where: { matchId } });
    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' });
    }

    if (parsedPlayer1Score == null || parsedPlayer2Score == null) {
      return res.status(400).json({ success: false, error: 'Missing required fields: player1Score, player2Score' });
    }

    const isDraw = Boolean(draw);
    if (!isDraw && !winnerId) {
      return res.status(400).json({ success: false, error: 'winnerId is required unless draw=true' });
    }

    if (winnerId && winnerId !== match.player1Id && winnerId !== match.player2Id) {
      return res.status(400).json({ success: false, error: 'Invalid winnerId' });
    }

    const adminRoles = new Set([
      'admin',
      'super_admin',
      'superuser',
      'superadmin',
      'manager',
      'director',
      'staff'
    ]);
    const isAdmin = adminRoles.has(requesterRole);
    const isService = requesterRole === 'service';
    const isHost = match.assignedHostPlayerUserId && match.assignedHostPlayerUserId === requesterId;
    const isPlayer = match.player1Id === requesterId || match.player2Id === requesterId;

    if (!isService && !isAdmin) {
      if (!isHost && !isPlayer) {
        return res.status(403).json({ success: false, error: 'Not allowed to complete this match' });
      }
    }

    const updatedMatch = await completeMatchAndProgress({
      matchId,
      winnerId,
      player1Score: parsedPlayer1Score,
      player2Score: parsedPlayer2Score,
      draw: isDraw,
      reason,
      matchDuration: matchDurationSeconds,
      completedAt
    });
    res.json({ success: true, data: updatedMatch });
  } catch (error) {
    logger.error('Update match result error:', error);
    res.status(500).json({ success: false, error: 'Failed to update match result' });
  }
};

exports.getSeasonBracket = async (req, res) => {
  try {
    const { seasonId } = req.params;
    if (!seasonId) {
      return res.status(400).json({ success: false, error: 'seasonId is required' });
    }

    const matches = await prisma.match.findMany({
      where: { seasonId },
      orderBy: [
        { scheduledTime: 'asc' },
        { createdAt: 'asc' }
      ]
    });

    const bracketMatches = matches.filter((match) => isBracketStage(match.stage));

    if (!bracketMatches.length) {
      return res.json({ success: true, data: { seasonId, stages: [] } });
    }

    const tournamentId = bracketMatches[0].tournamentId;
    const grouped = {};
    const stageOrder = Array.from(new Set(bracketMatches.map((match) => match.stage))).sort(
      (a, b) => getStageRank(a) - getStageRank(b)
    );

    for (const match of bracketMatches) {
      if (!grouped[match.stage]) grouped[match.stage] = [];
      grouped[match.stage].push(match);
    }

    const stages = stageOrder.map((stage, idx) => {
      const stageMatches = grouped[stage] || [];
      const nextStage = stageOrder[idx + 1];
      const nextMatches = nextStage ? grouped[nextStage] || [] : [];
      const canAdvance = stage !== 'final' && stage !== 'third_place';

      const mapped = stageMatches.map((match, matchIndex) => {
        const nextMatch = canAdvance ? nextMatches[Math.floor(matchIndex / 2)] || null : null;
        return {
          matchId: match.matchId,
          tournamentId: match.tournamentId,
          seasonId: match.seasonId,
          stage: match.stage,
          roundNumber: match.roundNumber,
          player1Id: match.player1Id,
          player2Id: match.player2Id,
          winnerId: match.winnerId,
          status: match.status,
          scheduledStartAt: match.scheduledStartAt || match.scheduledTime || null,
          assignedAgentId: match.assignedAgentId || null,
          assignedAgentUserId: match.assignedAgentUserId || null,
          winnerAdvancesToMatchId: nextMatch?.matchId || null,
          winnerAdvancesToSlot: nextMatch ? (matchIndex % 2 === 0 ? 'A' : 'B') : null
        };
      });

      return {
        stage,
        matches: mapped
      };
    }).filter((stage) => stage.matches.length > 0);

    res.json({
      success: true,
      data: {
        tournamentId,
        seasonId,
        stages
      }
    });
  } catch (error) {
    logger.error('Get season bracket error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch bracket' });
  }
};

exports.completeMatchAndProgress = completeMatchAndProgress;
exports.evaluateSeasonCompletion = evaluateSeasonCompletion;
