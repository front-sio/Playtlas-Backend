const { prisma } = require('../config/db.js');
const logger = require('../utils/logger');
const { publishEvent, Topics } = require('../../../../shared/events');
const { completeMatchAndProgress } = require('./matchmakingController');

/**
 * Handle match completion from club device
 * Determines tournament progression and next match assignments
 */
async function handleMatchCompletion(eventData) {
  try {
    const {
      matchId,
      winnerId,
      player1Score,
      player2Score,
      matchDuration,
      endReason,
      completedAt
    } = eventData;
    const matchDurationSeconds = matchDuration == null
      ? undefined
      : (Number.isFinite(Number(matchDuration)) ? Number(matchDuration) : undefined);

    logger.info({ matchId, winnerId }, '[matchmaking] Processing match completion');

    const match = await completeMatchAndProgress({
      matchId,
      winnerId,
      player1Score,
      player2Score,
      matchDuration: matchDurationSeconds,
      reason: endReason,
      completedAt
    });

    // Publish match result event
    await publishEvent(Topics.MATCH_RESULT_PROCESSED, {
      matchId,
      tournamentId: match.tournamentId,
      seasonId: match.seasonId,
      winnerId,
      loserId: winnerId === match.player1Id ? match.player2Id : match.player1Id,
      stage: match.stage,
      roundNumber: match.roundNumber
    });

  } catch (error) {
    logger.error({ err: error, matchId: eventData?.matchId }, '[matchmaking] Failed to process match completion');
    throw error;
  }
}

/**
 * Process tournament progression after match completion
 */
async function processTournamentProgression(match) {
  try {
    const { winnerId, tournamentId, seasonId, stage, winnerAdvancesToMatchId } = match;

    logger.info({
      matchId: match.matchId,
      tournamentId,
      seasonId,
      stage,
      winnerId
    }, '[matchmaking] Processing tournament progression');

    // If this is a group stage match
    if (stage === 'group') {
      await handleGroupStageProgression(match);
      return;
    }

    // If this is a knockout stage match with advancement
    if (winnerAdvancesToMatchId) {
      await handleKnockoutProgression(match);
      return;
    }

    // Final match completion drives season completion now.

  } catch (error) {
    logger.error({ err: error, matchId: match.matchId }, '[matchmaking] Failed to process tournament progression');
    throw error;
  }
}

/**
 * Handle group stage progression logic
 */
async function handleGroupStageProgression(match) {
  const { tournamentId, seasonId, bracketGroup } = match;

  // Check if all group matches are complete
  const groupMatches = await prisma.match.findMany({
    where: {
      tournamentId,
      seasonId,
      stage: 'group',
      bracketGroup
    }
  });

  const completedMatches = groupMatches.filter(m => m.status === 'completed');

  if (completedMatches.length === groupMatches.length) {
    // Group is complete, determine qualifiers
    const playerStats = calculateGroupStandings(completedMatches);
    const qualifiers = playerStats.slice(0, 2); // Top 2 qualify

    logger.info({
      tournamentId,
      seasonId,
      group: bracketGroup,
      qualifiers: qualifiers.map(q => q.playerId)
    }, '[matchmaking] Group stage complete, qualifiers determined');

    // Create next round matches if needed
    await createKnockoutMatches(tournamentId, seasonId, qualifiers);
  }
}

/**
 * Handle knockout stage progression
 */
async function handleKnockoutProgression(match) {
  const { winnerId, winnerAdvancesToMatchId, winnerAdvancesToSlot } = match;

  if (!winnerAdvancesToMatchId || !winnerAdvancesToSlot) {
    return;
  }

  // Update the next match with the winner
  const slotField = winnerAdvancesToSlot === 'player1' ? 'player1Id' : 'player2Id';

  await prisma.match.update({
    where: { matchId: winnerAdvancesToMatchId },
    data: {
      [slotField]: winnerId,
      status: 'ready' // Match is ready if both players are assigned
    }
  });

  logger.info({
    matchId: match.matchId,
    winnerId,
    nextMatchId: winnerAdvancesToMatchId,
    slot: winnerAdvancesToSlot
  }, '[matchmaking] Winner advanced to next round');
}

/**
 * Calculate group standings
 */
function calculateGroupStandings(matches) {
  const playerStats = {};

  matches.forEach(match => {
    if (match.status !== 'completed') return;

    const { player1Id, player2Id, winnerId, player1Score, player2Score } = match;

    // Initialize player stats if not exists
    if (!playerStats[player1Id]) {
      playerStats[player1Id] = { playerId: player1Id, wins: 0, losses: 0, points: 0 };
    }
    if (!playerStats[player2Id]) {
      playerStats[player2Id] = { playerId: player2Id, wins: 0, losses: 0, points: 0 };
    }

    // Update stats
    if (winnerId === player1Id) {
      playerStats[player1Id].wins++;
      playerStats[player1Id].points += player1Score;
      playerStats[player2Id].losses++;
      playerStats[player2Id].points += player2Score;
    } else {
      playerStats[player2Id].wins++;
      playerStats[player2Id].points += player2Score;
      playerStats[player1Id].losses++;
      playerStats[player1Id].points += player1Score;
    }
  });

  // Sort by wins (descending), then by points (descending)
  return Object.values(playerStats).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.points - a.points;
  });
}



/**
 * Create knockout matches for tournament progression
 */
async function createKnockoutMatches(tournamentId, seasonId, qualifiers) {
  // This would contain logic to create next round matches
  // Implementation depends on tournament format
  logger.info({ tournamentId, seasonId, qualifierCount: qualifiers.length }, '[matchmaking] Creating knockout matches');
}

module.exports = {
  handleMatchCompletion,
  processTournamentProgression,
  calculateGroupStandings
};
