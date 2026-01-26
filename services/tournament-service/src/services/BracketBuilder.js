const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * BracketBuilder - Creates and manages tournament bracket visualization
 * 
 * Handles:
 * - Building bracket structure for UI display
 * - Updating bracket as matches complete
 * - Managing progression from groups to knockout
 * - Providing bracket data for frontend visualization
 */
class BracketBuilder {

  /**
   * Build complete bracket structure for a season
   */
  async buildSeasonBracket(seasonId) {
    logger.info({ seasonId }, '[BracketBuilder] Building season bracket');

    const season = await prisma.season.findUnique({
      where: { seasonId },
      include: {
        matches: {
          orderBy: { matchNumber: 'asc' }
        },
        groupStandings: {
          orderBy: [
            { groupLabel: 'asc' },
            { groupPosition: 'asc' }
          ]
        }
      }
    });

    if (!season) {
      throw new Error('Season not found');
    }

    // Build group stage data
    const groups = await this.buildGroupStage(season.matches, season.groupStandings);
    
    // Build knockout bracket
    const bracket = await this.buildKnockoutBracket(seasonId, season.matches);
    
    // Get bracket progression paths
    const progressionPaths = await this.getBracketProgression(seasonId);

    const bracketData = {
      seasonId,
      groups,
      bracket,
      progressionPaths,
      lastUpdated: new Date().toISOString()
    };

    logger.info({ 
      seasonId,
      groupCount: Object.keys(groups).length,
      bracketLevels: bracket.levels?.length || 0
    }, '[BracketBuilder] Season bracket built');

    return bracketData;
  }

  /**
   * Build group stage visualization data
   */
  async buildGroupStage(matches, standings) {
    const groups = {};
    const groupLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

    // Initialize groups
    groupLabels.forEach(label => {
      groups[label] = {
        label,
        players: [],
        matches: [],
        standings: [],
        completed: false,
        qualifiers: []
      };
    });

    // Add group matches
    const groupMatches = matches.filter(m => m.round === 'GROUP');
    groupMatches.forEach(match => {
      if (match.groupLabel && groups[match.groupLabel]) {
        groups[match.groupLabel].matches.push({
          matchId: match.matchId,
          matchNumber: match.matchNumber,
          player1Id: match.player1Id,
          player2Id: match.player2Id,
          player1Score: match.player1Score,
          player2Score: match.player2Score,
          winnerId: match.winnerId,
          status: match.status,
          scheduledStartAt: match.scheduledStartAt,
          completedAt: match.completedAt
        });
      }
    });

    // Add standings and determine qualifiers
    standings.forEach(standing => {
      if (groups[standing.groupLabel]) {
        groups[standing.groupLabel].standings.push({
          playerId: standing.playerId,
          position: standing.groupPosition,
          matchesPlayed: standing.matchesPlayed,
          wins: standing.wins,
          losses: standing.losses,
          pointsFor: standing.pointsFor,
          pointsAgainst: standing.pointsAgainst,
          pointDifference: standing.pointDifference,
          winPercentage: standing.winPercentage,
          qualified: standing.qualified
        });

        // Add to players list if not already there
        if (!groups[standing.groupLabel].players.includes(standing.playerId)) {
          groups[standing.groupLabel].players.push(standing.playerId);
        }

        // Track qualifiers
        if (standing.qualified) {
          groups[standing.groupLabel].qualifiers.push({
            playerId: standing.playerId,
            position: standing.groupPosition // 1 = winner, 2 = runner-up
          });
        }
      }
    });

    // Check if groups are completed
    Object.keys(groups).forEach(groupLabel => {
      const group = groups[groupLabel];
      const totalMatches = group.matches.length;
      const completedMatches = group.matches.filter(m => m.status === 'COMPLETED').length;
      
      group.completed = (totalMatches === 6 && completedMatches === 6); // 6 matches per group
      
      // Sort standings by position
      group.standings.sort((a, b) => (a.position || 999) - (b.position || 999));
      
      // Sort qualifiers by position (winner first, runner-up second)
      group.qualifiers.sort((a, b) => a.position - b.position);
    });

    return groups;
  }

  /**
   * Build knockout bracket visualization structure
   */
  async buildKnockoutBracket(seasonId, matches) {
    const knockoutMatches = matches.filter(m => m.round !== 'GROUP');
    
    // Group matches by round
    const matchesByRound = {
      'R16': knockoutMatches.filter(m => m.round === 'R16'),
      'QF': knockoutMatches.filter(m => m.round === 'QF'),
      'SF': knockoutMatches.filter(m => m.round === 'SF'),
      'FINAL': knockoutMatches.filter(m => m.round === 'FINAL')
    };

    // Get bracket structure from database
    const bracketMatches = await prisma.bracketMatch.findMany({
      where: { seasonId },
      include: {
        match: true
      },
      orderBy: [
        { bracketLevel: 'desc' }, // Start from R16 (level 4)
        { position: 'asc' }
      ]
    });

    // Build bracket levels for visualization
    const levels = [
      {
        level: 4,
        name: 'Round of 16',
        matches: this.formatBracketMatches(matchesByRound['R16'])
      },
      {
        level: 3,
        name: 'Quarterfinals',
        matches: this.formatBracketMatches(matchesByRound['QF'])
      },
      {
        level: 2,
        name: 'Semifinals',
        matches: this.formatBracketMatches(matchesByRound['SF'])
      },
      {
        level: 1,
        name: 'Final',
        matches: this.formatBracketMatches(matchesByRound['FINAL'])
      }
    ];

    // Add bracket metadata for each match
    bracketMatches.forEach(bracket => {
      const level = levels.find(l => l.level === bracket.bracketLevel);
      if (level && bracket.match) {
        const match = level.matches.find(m => m.matchId === bracket.matchId);
        if (match) {
          match.bracketId = bracket.bracketId;
          match.position = bracket.position;
          match.parentMatchId = bracket.parentMatchId;
          match.bracketLevel = bracket.bracketLevel;
        }
      }
    });

    return {
      levels,
      totalMatches: knockoutMatches.length,
      completedMatches: knockoutMatches.filter(m => m.status === 'COMPLETED').length
    };
  }

  /**
   * Format bracket matches for visualization
   */
  formatBracketMatches(matches) {
    return matches.map(match => ({
      matchId: match.matchId,
      matchNumber: match.matchNumber,
      player1Id: match.player1Id,
      player2Id: match.player2Id,
      player1Score: match.player1Score,
      player2Score: match.player2Score,
      winnerId: match.winnerId,
      status: match.status,
      scheduledStartAt: match.scheduledStartAt,
      completedAt: match.completedAt,
      winnerAdvancesToMatchId: match.winnerAdvancesToMatchId,
      winnerAdvancesToSlot: match.winnerAdvancesToSlot,
      // These will be added by bracket metadata
      bracketId: null,
      position: null,
      parentMatchId: null,
      bracketLevel: null
    }));
  }

  /**
   * Get bracket progression paths for visualization
   */
  async getBracketProgression(seasonId) {
    const progressionPaths = [];

    // Get all knockout matches with progression info
    const matches = await prisma.match.findMany({
      where: {
        seasonId,
        round: { in: ['R16', 'QF', 'SF'] }, // Final doesn't advance anywhere
        winnerAdvancesToMatchId: { not: null }
      }
    });

    // Create progression path for each match
    matches.forEach(match => {
      progressionPaths.push({
        fromMatchId: match.matchId,
        toMatchId: match.winnerAdvancesToMatchId,
        slot: match.winnerAdvancesToSlot,
        fromRound: match.round,
        // Determine target round
        toRound: this.getNextRound(match.round)
      });
    });

    return progressionPaths;
  }

  /**
   * Get next round in tournament progression
   */
  getNextRound(currentRound) {
    const progression = {
      'R16': 'QF',
      'QF': 'SF', 
      'SF': 'FINAL',
      'FINAL': null
    };
    return progression[currentRound];
  }

  /**
   * Update bracket when a match is completed
   */
  async updateBracketOnMatchCompletion(matchId) {
    const match = await prisma.match.findUnique({
      where: { matchId },
      include: {
        season: true
      }
    });

    if (!match || match.status !== 'COMPLETED' || !match.winnerId) {
      return;
    }

    logger.info({ 
      matchId, 
      seasonId: match.seasonId,
      round: match.round,
      winnerId: match.winnerId
    }, '[BracketBuilder] Updating bracket for completed match');

    // If this is a group match, check if group is complete
    if (match.round === 'GROUP' && match.groupLabel) {
      await this.checkGroupCompletion(match.seasonId, match.groupLabel);
    }

    // If this is a knockout match, advance winner to next round
    if (match.round !== 'GROUP' && match.winnerAdvancesToMatchId) {
      await this.advanceWinnerToNextRound(match);
    }

    // Update bracket visualization data
    await this.updateBracketVisualization(match.seasonId);

    logger.info({ 
      matchId, 
      seasonId: match.seasonId 
    }, '[BracketBuilder] Bracket updated for match completion');
  }

  /**
   * Check if a group stage is complete and advance qualifiers
   */
  async checkGroupCompletion(seasonId, groupLabel) {
    // Get all matches in this group
    const groupMatches = await prisma.match.findMany({
      where: {
        seasonId,
        round: 'GROUP',
        groupLabel
      }
    });

    const completedMatches = groupMatches.filter(m => m.status === 'COMPLETED');
    
    // If all 6 group matches are complete, advance qualifiers
    if (completedMatches.length === 6) {
      const qualifiers = await prisma.groupStanding.findMany({
        where: {
          seasonId,
          groupLabel,
          qualified: true
        },
        orderBy: { groupPosition: 'asc' }
      });

      if (qualifiers.length >= 2) {
        const winner = qualifiers[0];
        const runnerUp = qualifiers[1];
        
        await this.advanceGroupQualifiers(seasonId, groupLabel, winner.playerId, runnerUp.playerId);
        
        logger.info({ 
          seasonId, 
          groupLabel,
          winner: winner.playerId,
          runnerUp: runnerUp.playerId
        }, '[BracketBuilder] Group completed, qualifiers advanced');
      }
    }
  }

  /**
   * Advance group qualifiers to Round of 16
   */
  async advanceGroupQualifiers(seasonId, groupLabel, winnerId, runnerUpId) {
    // Group pairing logic for R16 (same as in SeasonGenerator)
    const groupPairings = {
      'A': { winnerSlot: 1, runnerUpSlot: 2 },  // A1 vs B2
      'B': { winnerSlot: 2, runnerUpSlot: 1 },  // B1 vs A2
      'C': { winnerSlot: 3, runnerUpSlot: 4 },  // C1 vs D2
      'D': { winnerSlot: 4, runnerUpSlot: 3 },  // D1 vs C2
      'E': { winnerSlot: 5, runnerUpSlot: 6 },  // E1 vs F2
      'F': { winnerSlot: 6, runnerUpSlot: 5 },  // F1 vs E2
      'G': { winnerSlot: 7, runnerUpSlot: 8 },  // G1 vs H2
      'H': { winnerSlot: 8, runnerUpSlot: 7 }   // H1 vs G2
    };

    const pairing = groupPairings[groupLabel];
    if (!pairing) {
      throw new Error(`Invalid group label: ${groupLabel}`);
    }

    // Get R16 matches in order
    const r16Matches = await prisma.match.findMany({
      where: { seasonId, round: 'R16' },
      orderBy: { matchNumber: 'asc' }
    });

    // Assign winner to their R16 slot
    const winnerMatch = r16Matches[pairing.winnerSlot - 1];
    if (winnerMatch) {
      await prisma.match.update({
        where: { matchId: winnerMatch.matchId },
        data: { 
          [winnerMatch.player1Id ? 'player2Id' : 'player1Id']: winnerId,
          status: winnerMatch.player1Id && winnerMatch.player2Id ? 'READY' : 'SCHEDULED'
        }
      });
    }

    // Assign runner-up to their R16 slot
    const runnerUpMatch = r16Matches[pairing.runnerUpSlot - 1];
    if (runnerUpMatch) {
      await prisma.match.update({
        where: { matchId: runnerUpMatch.matchId },
        data: { 
          [runnerUpMatch.player1Id ? 'player2Id' : 'player1Id']: runnerUpId,
          status: runnerUpMatch.player1Id && runnerUpMatch.player2Id ? 'READY' : 'SCHEDULED'
        }
      });
    }
  }

  /**
   * Advance winner to next round in knockout stage
   */
  async advanceWinnerToNextRound(match) {
    if (!match.winnerAdvancesToMatchId || !match.winnerAdvancesToSlot || !match.winnerId) {
      return;
    }

    const nextMatch = await prisma.match.findUnique({
      where: { matchId: match.winnerAdvancesToMatchId }
    });

    if (!nextMatch) {
      logger.error({ 
        matchId: match.matchId,
        nextMatchId: match.winnerAdvancesToMatchId 
      }, '[BracketBuilder] Next match not found');
      return;
    }

    // Determine which slot to fill (A = player1, B = player2)
    const slotField = match.winnerAdvancesToSlot === 'A' ? 'player1Id' : 'player2Id';
    const updateData = { [slotField]: match.winnerId };
    
    // If both players are now assigned, mark match as ready
    if (slotField === 'player1Id' && nextMatch.player2Id) {
      updateData.status = 'READY';
    } else if (slotField === 'player2Id' && nextMatch.player1Id) {
      updateData.status = 'READY';
    }

    await prisma.match.update({
      where: { matchId: match.winnerAdvancesToMatchId },
      data: updateData
    });

    logger.info({ 
      matchId: match.matchId,
      winnerId: match.winnerId,
      nextMatchId: match.winnerAdvancesToMatchId,
      slot: match.winnerAdvancesToSlot
    }, '[BracketBuilder] Winner advanced to next round');
  }

  /**
   * Update bracket visualization data
   */
  async updateBracketVisualization(seasonId) {
    // This could trigger real-time updates to connected clients
    // For now, we'll just log that an update occurred
    logger.info({ seasonId }, '[BracketBuilder] Bracket visualization updated');
    
    // In a real implementation, this would emit events to WebSocket clients
    // or update a cached bracket structure for faster API responses
  }

  /**
   * Get bracket status summary
   */
  async getBracketStatus(seasonId) {
    const matches = await prisma.match.findMany({
      where: { seasonId }
    });

    const status = {
      seasonId,
      totalMatches: matches.length,
      completedMatches: matches.filter(m => m.status === 'COMPLETED').length,
      inProgressMatches: matches.filter(m => m.status === 'IN_PROGRESS').length,
      scheduledMatches: matches.filter(m => m.status === 'SCHEDULED').length,
      readyMatches: matches.filter(m => m.status === 'READY').length,
      rounds: {}
    };

    // Status by round
    const rounds = ['GROUP', 'R16', 'QF', 'SF', 'FINAL'];
    rounds.forEach(round => {
      const roundMatches = matches.filter(m => m.round === round);
      status.rounds[round] = {
        total: roundMatches.length,
        completed: roundMatches.filter(m => m.status === 'COMPLETED').length,
        inProgress: roundMatches.filter(m => m.status === 'IN_PROGRESS').length,
        ready: roundMatches.filter(m => m.status === 'READY').length,
        scheduled: roundMatches.filter(m => m.status === 'SCHEDULED').length
      };
    });

    return status;
  }

  /**
   * Generate bracket visualization data for frontend
   */
  async generateBracketVisualization(seasonId) {
    const bracketData = await this.buildSeasonBracket(seasonId);
    
    // Transform data for frontend visualization library
    const visualization = {
      groups: bracketData.groups,
      rounds: [
        {
          name: 'Round of 16',
          matches: bracketData.bracket.levels.find(l => l.level === 4)?.matches || []
        },
        {
          name: 'Quarterfinals', 
          matches: bracketData.bracket.levels.find(l => l.level === 3)?.matches || []
        },
        {
          name: 'Semifinals',
          matches: bracketData.bracket.levels.find(l => l.level === 2)?.matches || []
        },
        {
          name: 'Final',
          matches: bracketData.bracket.levels.find(l => l.level === 1)?.matches || []
        }
      ],
      progressionPaths: bracketData.progressionPaths,
      lastUpdated: bracketData.lastUpdated
    };

    return visualization;
  }
}

module.exports = { BracketBuilder };