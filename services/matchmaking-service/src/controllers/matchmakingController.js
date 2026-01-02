const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const { publishEvent, Topics } = require('../../../../shared/events');
const { createMatches } = require('./matchCreationController');
const { getIO } = require('../utils/socket');

const prisma = new PrismaClient();

const NEXT_STAGE = {
  round_of_32: 'round_of_16',
  round_of_16: 'quarterfinal',
  quarterfinal: 'semifinal',
  semifinal: 'third_place',
  third_place: 'final'
};
const GROUP_QUALIFIERS = Number(process.env.GROUP_QUALIFIERS || 2);

const BYE_PLAYER_ID = '00000000-0000-0000-0000-000000000000';

function getInitialStage(playerCount) {
  if (playerCount <= 2) return 'final';
  if (playerCount <= 4) return 'semifinal';
  if (playerCount <= 8) return 'quarterfinal';
  if (playerCount <= 16) return 'round_of_16';
  return 'round_of_32';
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
      roundNumber: 1
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
    const thirdPlaceMatch = await prisma.match.findFirst({
      where: {
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        stage: 'third_place',
        status: 'completed'
      }
    });

    const finalLoser = getMatchLoser(match);
    const placements = {
      first: match.winnerId,
      second: finalLoser || null,
      third: thirdPlaceMatch?.winnerId || null
    };

    await publishEvent(
      Topics.SEASON_COMPLETED,
      {
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        status: 'completed',
        endedAt: new Date().toISOString(),
        placements
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
      roundNumber: match.roundNumber
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
      if (thirdPlaceExists) return;

      const thirdMatches = await createMatches(losers.slice(0, 2), {
        tournamentId: match.tournamentId,
        seasonId: match.seasonId,
        stage: 'third_place',
        roundNumber: match.roundNumber + 1
      });
      await emitRoundMatches(match.tournamentId, match.seasonId, 'third_place', match.roundNumber + 1, thirdMatches);
      return;
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
        roundNumber: match.roundNumber + 1
      });
      await emitRoundMatches(match.tournamentId, match.seasonId, 'final', match.roundNumber + 1, finalMatches);
    }
    return;
  }

  const nextStage = NEXT_STAGE[match.stage];
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
    roundNumber: match.roundNumber + 1
  });

  await emitRoundMatches(match.tournamentId, match.seasonId, nextStage, match.roundNumber + 1, nextMatches);
}

async function completeMatchAndProgress({ matchId, winnerId, player1Score, player2Score }) {
  const match = await prisma.match.findUnique({ where: { matchId } });
  if (!match) {
    const err = new Error('Match not found');
    err.statusCode = 404;
    throw err;
  }
  if (match.status === 'completed' && match.winnerId) {
    return match;
  }

  const loserId = match.player1Id === winnerId ? match.player2Id : match.player1Id;

  const updatedMatch = await prisma.match.update({
    where: { matchId },
    data: {
      winnerId,
      status: 'completed',
      completedAt: new Date(),
      player1Score,
      player2Score,
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
    });
  } catch (eventErr) {
    logger.error('Failed to publish MATCH_COMPLETED event:', eventErr);
  }

  logger.info(`Match ${matchId} completed, winner: ${winnerId}`);
  await progressTournament(updatedMatch);
  return updatedMatch;
}

exports.updateMatchResult = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { winnerId, player1Score, player2Score } = req.body;

    const updatedMatch = await completeMatchAndProgress({
      matchId,
      winnerId,
      player1Score,
      player2Score,
    });
    res.json({ success: true, data: updatedMatch });
  } catch (error) {
    logger.error('Update match result error:', error);
    res.status(500).json({ success: false, error: 'Failed to update match result' });
  }
};

exports.completeMatchAndProgress = completeMatchAndProgress;
