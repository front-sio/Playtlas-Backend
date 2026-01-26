const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * SeasonGenerator - Creates comprehensive tournament seasons with group stage + knockout
 * 
 * Tournament Format:
 * - 32 players per season
 * - 8 groups (A-H), 4 players per group  
 * - Group stage: round-robin (6 matches per group, 48 total)
 * - Top 2 per group advance to Round of 16
 * - Knockout: R16 (8), QF (4), SF (2), Final (1)
 * - Total matches per season: 63
 */
class SeasonGenerator {
  
  /**
   * Generate a complete season with all matches
   */
  async generateSeason(tournamentId, seasonNumber, playerIds) {
    if (playerIds.length !== 32) {
      throw new Error('Season must have exactly 32 players');
    }

    logger.info({ 
      tournamentId, 
      seasonNumber, 
      playerCount: playerIds.length 
    }, '[SeasonGenerator] Starting season generation');

    const tournament = await prisma.tournament.findUnique({
      where: { tournamentId },
      include: { club: true }
    });

    if (!tournament) {
      throw new Error('Tournament not found');
    }

    // Create season
    const season = await prisma.season.create({
      data: {
        tournamentId,
        clubId: tournament.clubId,
        seasonNumber,
        name: `Season ${seasonNumber}`,
        status: 'active',
        startTime: new Date(),
        endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 1 week from now
        matchesGenerated: true
      }
    });

    logger.info({ seasonId: season.seasonId }, '[SeasonGenerator] Season created');

    // Register players for season
    await this.registerPlayers(season.seasonId, tournamentId, playerIds);
    
    // Generate all matches
    const matches = await this.generateAllMatches(season, playerIds);
    
    // Create bracket structure
    await this.createBracketStructure(season.seasonId, matches.knockout);

    logger.info({ 
      seasonId: season.seasonId,
      totalMatches: matches.group.length + matches.knockout.length,
      groupMatches: matches.group.length,
      knockoutMatches: matches.knockout.length
    }, '[SeasonGenerator] Season generation completed');

    return {
      season,
      matches: matches.group.concat(matches.knockout),
      groupMatches: matches.group,
      knockoutMatches: matches.knockout
    };
  }

  /**
   * Register players for the season
   */
  async registerPlayers(seasonId, tournamentId, playerIds) {
    const playerRegistrations = playerIds.map(playerId => ({
      tournamentId,
      seasonId,
      playerId,
      status: 'registered'
    }));

    await prisma.tournamentPlayer.createMany({
      data: playerRegistrations
    });

    logger.info({ 
      seasonId, 
      playerCount: playerIds.length 
    }, '[SeasonGenerator] Players registered');
  }

  /**
   * Generate all matches for the season
   */
  async generateAllMatches(season, playerIds) {
    // Shuffle players and assign to groups
    const shuffledPlayers = [...playerIds].sort(() => Math.random() - 0.5);
    const groups = this.createGroups(shuffledPlayers);
    
    // Generate group stage matches
    const groupMatches = await this.generateGroupStageMatches(season, groups);
    
    // Generate knockout stage matches (with placeholders)
    const knockoutMatches = await this.generateKnockoutMatches(season);

    return {
      group: groupMatches,
      knockout: knockoutMatches
    };
  }

  /**
   * Create 8 groups of 4 players each
   */
  createGroups(playerIds) {
    const groups = {};
    const groupLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    
    groupLabels.forEach((label, index) => {
      groups[label] = playerIds.slice(index * 4, (index + 1) * 4);
    });

    logger.info({ groups: Object.keys(groups) }, '[SeasonGenerator] Groups created');
    return groups;
  }

  /**
   * Generate group stage matches (round-robin within each group)
   */
  async generateGroupStageMatches(season, groups) {
    const matches = [];
    let matchNumber = 1;

    for (const [groupLabel, groupPlayers] of Object.entries(groups)) {
      // Generate round-robin matches for this group (6 matches total)
      for (let i = 0; i < groupPlayers.length; i++) {
        for (let j = i + 1; j < groupPlayers.length; j++) {
          matches.push({
            tournamentId: season.tournamentId,
            seasonId: season.seasonId,
            clubId: season.clubId,
            round: 'GROUP',
            groupLabel,
            matchNumber: matchNumber++,
            player1Id: groupPlayers[i],
            player2Id: groupPlayers[j],
            status: 'SCHEDULED'
          });
        }
      }

      // Initialize group standings for all players in this group
      const standings = groupPlayers.map(playerId => ({
        seasonId: season.seasonId,
        groupLabel,
        playerId,
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        winPercentage: 0,
        pointDifference: 0,
        qualified: false
      }));

      await prisma.groupStanding.createMany({
        data: standings,
        skipDuplicates: true
      });
    }

    // Create all group matches
    const createdMatches = await prisma.match.createMany({
      data: matches,
      skipDuplicates: true
    });

    logger.info({ 
      seasonId: season.seasonId,
      groupMatchCount: matches.length,
      groupsCount: Object.keys(groups).length
    }, '[SeasonGenerator] Group stage matches generated');

    return matches;
  }

  /**
   * Generate knockout stage matches with placeholders
   */
  async generateKnockoutMatches(season) {
    const matches = [];
    let matchNumber = 49; // Continue from group stage

    // Round of 16 (8 matches)
    const r16Matches = [];
    for (let i = 1; i <= 8; i++) {
      const match = {
        tournamentId: season.tournamentId,
        seasonId: season.seasonId,
        clubId: season.clubId,
        round: 'R16',
        groupLabel: null,
        matchNumber: matchNumber++,
        player1Id: null, // Will be filled from group winners
        player2Id: null, // Will be filled from group runners-up
        status: 'SCHEDULED'
      };
      r16Matches.push(match);
      matches.push(match);
    }

    // Quarterfinals (4 matches)
    const qfMatches = [];
    for (let i = 1; i <= 4; i++) {
      const match = {
        tournamentId: season.tournamentId,
        seasonId: season.seasonId,
        clubId: season.clubId,
        round: 'QF',
        groupLabel: null,
        matchNumber: matchNumber++,
        player1Id: null,
        player2Id: null,
        status: 'SCHEDULED'
      };
      qfMatches.push(match);
      matches.push(match);
    }

    // Semifinals (2 matches)
    const sfMatches = [];
    for (let i = 1; i <= 2; i++) {
      const match = {
        tournamentId: season.tournamentId,
        seasonId: season.seasonId,
        clubId: season.clubId,
        round: 'SF',
        groupLabel: null,
        matchNumber: matchNumber++,
        player1Id: null,
        player2Id: null,
        status: 'SCHEDULED'
      };
      sfMatches.push(match);
      matches.push(match);
    }

    // Final (1 match)
    const finalMatch = {
      tournamentId: season.tournamentId,
      seasonId: season.seasonId,
      clubId: season.clubId,
      round: 'FINAL',
      groupLabel: null,
      matchNumber: matchNumber++,
      player1Id: null,
      player2Id: null,
      status: 'SCHEDULED'
    };
    matches.push(finalMatch);

    // Create matches and set up progression links
    const createdMatches = await prisma.match.createMany({
      data: matches,
      skipDuplicates: true
    });

    // Get the created matches with IDs for linking
    const dbMatches = await prisma.match.findMany({
      where: {
        seasonId: season.seasonId,
        round: { in: ['R16', 'QF', 'SF', 'FINAL'] }
      },
      orderBy: { matchNumber: 'asc' }
    });

    // Set up progression links
    await this.setupKnockoutProgression(dbMatches);

    logger.info({ 
      seasonId: season.seasonId,
      knockoutMatchCount: matches.length
    }, '[SeasonGenerator] Knockout stage matches generated');

    return matches;
  }

  /**
   * Set up knockout stage progression links
   */
  async setupKnockoutProgression(matches) {
    const r16Matches = matches.filter(m => m.round === 'R16');
    const qfMatches = matches.filter(m => m.round === 'QF');
    const sfMatches = matches.filter(m => m.round === 'SF');
    const finalMatch = matches.find(m => m.round === 'FINAL');

    // Link R16 to QF
    for (let i = 0; i < r16Matches.length; i += 2) {
      const qfIndex = Math.floor(i / 2);
      
      await prisma.match.update({
        where: { matchId: r16Matches[i].matchId },
        data: {
          winnerAdvancesToMatchId: qfMatches[qfIndex].matchId,
          winnerAdvancesToSlot: 'A'
        }
      });
      
      await prisma.match.update({
        where: { matchId: r16Matches[i + 1].matchId },
        data: {
          winnerAdvancesToMatchId: qfMatches[qfIndex].matchId,
          winnerAdvancesToSlot: 'B'
        }
      });
    }

    // Link QF to SF
    for (let i = 0; i < qfMatches.length; i += 2) {
      const sfIndex = Math.floor(i / 2);
      
      await prisma.match.update({
        where: { matchId: qfMatches[i].matchId },
        data: {
          winnerAdvancesToMatchId: sfMatches[sfIndex].matchId,
          winnerAdvancesToSlot: 'A'
        }
      });
      
      await prisma.match.update({
        where: { matchId: qfMatches[i + 1].matchId },
        data: {
          winnerAdvancesToMatchId: sfMatches[sfIndex].matchId,
          winnerAdvancesToSlot: 'B'
        }
      });
    }

    // Link SF to Final
    await prisma.match.update({
      where: { matchId: sfMatches[0].matchId },
      data: {
        winnerAdvancesToMatchId: finalMatch.matchId,
        winnerAdvancesToSlot: 'A'
      }
    });
    
    await prisma.match.update({
      where: { matchId: sfMatches[1].matchId },
      data: {
        winnerAdvancesToMatchId: finalMatch.matchId,
        winnerAdvancesToSlot: 'B'
      }
    });

    logger.info('[SeasonGenerator] Knockout progression links established');
  }

  /**
   * Create bracket structure for visualization
   */
  async createBracketStructure(seasonId, knockoutMatches) {
    const brackets = [];

    // Get knockout matches from database with IDs
    const dbMatches = await prisma.match.findMany({
      where: {
        seasonId,
        round: { in: ['R16', 'QF', 'SF', 'FINAL'] }
      },
      orderBy: { matchNumber: 'asc' }
    });

    // Create bracket entries
    dbMatches.forEach((match, index) => {
      let bracketLevel, position;
      
      switch (match.round) {
        case 'R16':
          bracketLevel = 4;
          position = (index % 8) + 1;
          break;
        case 'QF':
          bracketLevel = 3;
          position = (index % 4) + 1;
          break;
        case 'SF':
          bracketLevel = 2;
          position = (index % 2) + 1;
          break;
        case 'FINAL':
          bracketLevel = 1;
          position = 1;
          break;
      }

      brackets.push({
        seasonId,
        round: match.round,
        position,
        matchId: match.matchId,
        bracketLevel,
        parentMatchId: match.winnerAdvancesToMatchId
      });
    });

    await prisma.bracketMatch.createMany({
      data: brackets,
      skipDuplicates: true
    });

    logger.info({ 
      seasonId, 
      bracketCount: brackets.length 
    }, '[SeasonGenerator] Bracket structure created');
  }

  /**
   * Process group stage completion and advance qualifiers
   */
  async processGroupCompletion(seasonId, groupLabel) {
    // Get final group standings
    const standings = await prisma.groupStanding.findMany({
      where: { seasonId, groupLabel },
      orderBy: [
        { wins: 'desc' },
        { pointDifference: 'desc' },
        { pointsFor: 'desc' }
      ]
    });

    if (standings.length < 4) {
      throw new Error(`Group ${groupLabel} does not have 4 players`);
    }

    // Mark top 2 as qualified
    const qualifiers = standings.slice(0, 2);
    const winner = qualifiers[0];
    const runnerUp = qualifiers[1];

    await prisma.groupStanding.updateMany({
      where: { 
        seasonId, 
        groupLabel,
        playerId: { in: [winner.playerId, runnerUp.playerId] }
      },
      data: { qualified: true }
    });

    // Advance qualifiers to R16
    await this.advanceToKnockout(seasonId, groupLabel, winner.playerId, runnerUp.playerId);

    logger.info({ 
      seasonId, 
      groupLabel,
      winner: winner.playerId,
      runnerUp: runnerUp.playerId
    }, '[SeasonGenerator] Group stage completed, qualifiers advanced');

    return { winner, runnerUp };
  }

  /**
   * Advance group qualifiers to Round of 16
   */
  async advanceToKnockout(seasonId, groupLabel, winnerId, runnerUpId) {
    // Group pairing logic for R16
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

    // Get R16 matches
    const r16Matches = await prisma.match.findMany({
      where: { seasonId, round: 'R16' },
      orderBy: { matchNumber: 'asc' }
    });

    // Assign winner to their slot
    const winnerMatch = r16Matches[pairing.winnerSlot - 1];
    await prisma.match.update({
      where: { matchId: winnerMatch.matchId },
      data: { 
        [winnerMatch.player1Id ? 'player2Id' : 'player1Id']: winnerId
      }
    });

    // Assign runner-up to their slot
    const runnerUpMatch = r16Matches[pairing.runnerUpSlot - 1];
    await prisma.match.update({
      where: { matchId: runnerUpMatch.matchId },
      data: { 
        [runnerUpMatch.player1Id ? 'player2Id' : 'player1Id']: runnerUpId
      }
    });
  }
}

module.exports = { SeasonGenerator };