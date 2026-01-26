const express = require('express');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const logger = require('../utils/logger');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();
const prisma = new PrismaClient();
const MATCHMAKING_SERVICE_URL = process.env.MATCHMAKING_SERVICE_URL || 'http://matchmaking-service:3009';

router.use(authMiddleware);

function normalizeRound(match) {
  const raw = match?.round || match?.stage || '';
  const key = String(raw || '').trim().toUpperCase();
  if (key.startsWith('ROUND_OF_')) {
    const count = Number(key.replace('ROUND_OF_', ''));
    if (Number.isFinite(count)) {
      return `R${count}`;
    }
  }
  if (key === 'GROUP') return 'GROUP';
  if (key === 'QUARTERFINAL' || key === 'QUARTERFINALS') return 'QF';
  if (key === 'SEMIFINAL' || key === 'SEMIFINALS') return 'SF';
  if (key === 'FINAL') return 'FINAL';
  if (key === 'R32' || key === 'R16' || key === 'QF' || key === 'SF') return key;
  return key || 'GROUP';
}

function normalizeStatus(status) {
  const raw = String(status || '').trim().toUpperCase();
  if (raw === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (raw === 'COMPLETED') return 'COMPLETED';
  if (raw === 'READY') return 'READY';
  return raw || 'SCHEDULED';
}

function getGroupLabel(match) {
  return (
    match?.groupLabel ||
    match?.bracketGroup ||
    match?.metadata?.groupLabel ||
    match?.metadata?.group ||
    null
  );
}

async function fetchSeasonMatches({ tournamentId, seasonId }) {
  const response = await axios.get(
    `${MATCHMAKING_SERVICE_URL}/matchmaking/tournament/${encodeURIComponent(tournamentId)}/matches`,
    { params: { seasonId } }
  );
  const payload = response.data?.data || {};
  return Array.isArray(payload.matches) ? payload.matches : [];
}

async function fetchSeasonBracket({ seasonId, authHeader }) {
  const response = await axios.get(
    `${MATCHMAKING_SERVICE_URL}/matchmaking/season/${encodeURIComponent(seasonId)}/bracket`,
    {
      headers: authHeader ? { Authorization: authHeader } : undefined,
      timeout: 10000
    }
  );
  return response.data?.data || null;
}

// Player API routes - view only access to tournament data

/**
 * GET /api/player/tournaments
 * Get tournaments for player's club
 */
router.get('/tournaments', async (req, res) => {
  try {
    const { clubId } = req.query;
    const playerId = req.user?.userId;

    if (!clubId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Club ID required' 
      });
    }

    const tournaments = await prisma.tournament.findMany({
      where: { clubId },
      include: {
        seasons: {
          where: {
            tournamentPlayers: {
              some: { playerId }
            }
          },
          orderBy: { seasonNumber: 'desc' }
        },
        _count: {
          select: {
            tournamentPlayers: true,
            seasons: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: tournaments.map(tournament => ({
        tournamentId: tournament.tournamentId,
        name: tournament.name,
        description: tournament.description,
        entryFee: tournament.entryFee,
        maxPlayers: tournament.maxPlayers,
        currentPlayers: tournament._count.tournamentPlayers,
        status: tournament.status,
        stage: tournament.stage,
        startTime: tournament.startTime,
        endTime: tournament.endTime,
        operatingHours: {
          start: tournament.operatingHoursStart,
          end: tournament.operatingHoursEnd
        },
        matchDurationMinutes: tournament.matchDurationMinutes,
        seasons: tournament.seasons,
        totalSeasons: tournament._count.seasons,
        createdAt: tournament.createdAt
      }))
    });

  } catch (error) {
    logger.error({ err: error }, '[PlayerAPI] Failed to get tournaments');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve tournaments'
    });
  }
});

/**
 * GET /api/player/seasons/:seasonId/fixtures
 * Get all fixtures for a season
 */
router.get('/seasons/:seasonId/fixtures', async (req, res) => {
  try {
    const { seasonId } = req.params;
    const { round } = req.query; // Optional filter by round
    const playerId = req.user?.userId;

    // Verify player is in this season
    const playerInSeason = await prisma.tournamentPlayer.findFirst({
      where: {
        seasonId,
        playerId
      }
    });

    if (!playerInSeason) {
      return res.status(403).json({
        success: false,
        error: 'Access denied to this season'
      });
    }

    const season = await prisma.season.findUnique({
      where: { seasonId },
      select: { tournamentId: true }
    });
    if (!season?.tournamentId) {
      return res.status(404).json({ success: false, error: 'Season not found' });
    }

    const matches = await fetchSeasonMatches({
      tournamentId: season.tournamentId,
      seasonId
    });

    const fixtures = matches.map((match, index) => {
      const normalizedRound = normalizeRound(match);
      return {
        matchId: match.matchId,
        matchNumber: match.matchNumber || index + 1,
        round: normalizedRound,
        groupLabel: getGroupLabel(match),
        player1Id: match.player1Id,
        player2Id: match.player2Id,
        player1Score: match.player1Score ?? 0,
        player2Score: match.player2Score ?? 0,
        winnerId: match.winnerId || null,
        status: normalizeStatus(match.status),
        scheduledStartAt: match.scheduledStartAt || match.scheduledTime || null,
        assignedDeviceId: match.assignedDeviceId || null,
        assignedAgentId: match.assignedAgentId || null,
        assignedHostPlayerUserId: match.assignedHostPlayerUserId || null,
        verificationStatus: match.verificationStatus || null,
        startedAt: match.startedAt || null,
        completedAt: match.completedAt || null,
        matchDurationSeconds: match.matchDurationSeconds || match.matchDuration || null,
        isPlayerMatch: match.player1Id === playerId || match.player2Id === playerId,
        playerPosition: match.player1Id === playerId ? 1 : (match.player2Id === playerId ? 2 : null)
      };
    }).filter((match) => {
      if (!round) return true;
      return String(match.round).toUpperCase() === String(round).toUpperCase();
    });

    // Group fixtures by round for better organization
    const fixturesByRound = {};
    fixtures.forEach(match => {
      if (!fixturesByRound[match.round]) {
        fixturesByRound[match.round] = [];
      }
      
      fixturesByRound[match.round].push(match);
    });

    res.json({
      success: true,
      data: {
        seasonId,
        fixturesByRound,
        totalFixtures: fixtures.length,
        playerMatches: fixtures.filter(m => 
          m.player1Id === playerId || m.player2Id === playerId
        ).length
      }
    });

  } catch (error) {
    logger.error({ err: error, seasonId: req.params.seasonId }, '[PlayerAPI] Failed to get fixtures');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve fixtures'
    });
  }
});

/**
 * GET /api/player/seasons/:seasonId/groups
 * Get group standings for a season
 */
router.get('/seasons/:seasonId/groups', async (req, res) => {
  try {
    const { seasonId } = req.params;
    const playerId = req.user?.userId;

    // Verify player access
    const playerInSeason = await prisma.tournamentPlayer.findFirst({
      where: {
        seasonId,
        playerId
      }
    });

    if (!playerInSeason) {
      return res.status(403).json({
        success: false,
        error: 'Access denied to this season'
      });
    }

    const season = await prisma.season.findUnique({
      where: { seasonId },
      select: { tournamentId: true }
    });
    if (!season?.tournamentId) {
      return res.status(404).json({ success: false, error: 'Season not found' });
    }

    const matches = await fetchSeasonMatches({
      tournamentId: season.tournamentId,
      seasonId
    });

    const groupMatches = matches
      .map((match) => ({ ...match, round: normalizeRound(match), groupLabel: getGroupLabel(match) }))
      .filter((match) => match.round === 'GROUP' && match.groupLabel);

    const groupLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const standingsByGroup = {};
    const matchesByGroup = {};
    const statsByGroup = {};

    groupLabels.forEach((label) => {
      standingsByGroup[label] = [];
      matchesByGroup[label] = [];
    });

    groupMatches.forEach((match) => {
      const label = match.groupLabel;
      if (!label) return;
      if (!statsByGroup[label]) statsByGroup[label] = new Map();

      matchesByGroup[label].push({
        matchId: match.matchId,
        player1Id: match.player1Id,
        player2Id: match.player2Id,
        player1Score: match.player1Score ?? 0,
        player2Score: match.player2Score ?? 0,
        winnerId: match.winnerId || null,
        status: normalizeStatus(match.status),
        scheduledStartAt: match.scheduledStartAt || match.scheduledTime || null,
        completedAt: match.completedAt || null
      });

      const ensurePlayer = (pid) => {
        if (!statsByGroup[label].has(pid)) {
          statsByGroup[label].set(pid, {
            playerId: pid,
            matchesPlayed: 0,
            wins: 0,
            losses: 0,
            pointsFor: 0,
            pointsAgainst: 0
          });
        }
        return statsByGroup[label].get(pid);
      };

      const p1 = ensurePlayer(match.player1Id);
      const p2 = ensurePlayer(match.player2Id);

      if (match.winnerId || normalizeStatus(match.status) === 'COMPLETED') {
        p1.matchesPlayed += 1;
        p2.matchesPlayed += 1;
        p1.pointsFor += Number(match.player1Score || 0);
        p1.pointsAgainst += Number(match.player2Score || 0);
        p2.pointsFor += Number(match.player2Score || 0);
        p2.pointsAgainst += Number(match.player1Score || 0);

        if (match.winnerId === match.player1Id) {
          p1.wins += 1;
          p2.losses += 1;
        } else if (match.winnerId === match.player2Id) {
          p2.wins += 1;
          p1.losses += 1;
        }
      }
    });

    groupLabels.forEach((label) => {
      const stats = Array.from((statsByGroup[label] || new Map()).values());
      stats.sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        const diffA = a.pointsFor - a.pointsAgainst;
        const diffB = b.pointsFor - b.pointsAgainst;
        if (diffB !== diffA) return diffB - diffA;
        return b.pointsFor - a.pointsFor;
      });

      standingsByGroup[label] = stats.map((stat, index) => {
        const pointDifference = stat.pointsFor - stat.pointsAgainst;
        return {
          playerId: stat.playerId,
          position: index + 1,
          matchesPlayed: stat.matchesPlayed,
          wins: stat.wins,
          losses: stat.losses,
          pointsFor: stat.pointsFor,
          pointsAgainst: stat.pointsAgainst,
          pointDifference,
          winPercentage: stat.matchesPlayed ? stat.wins / stat.matchesPlayed : 0,
          qualified: index < 2,
          isCurrentPlayer: stat.playerId === playerId
        };
      });
    });

    res.json({
      success: true,
      data: {
        seasonId,
        standingsByGroup,
        matchesByGroup,
        playerGroup: Object.keys(standingsByGroup).find(group => 
          standingsByGroup[group].some(s => s.isCurrentPlayer)
        )
      }
    });

  } catch (error) {
    logger.error({ err: error, seasonId: req.params.seasonId }, '[PlayerAPI] Failed to get groups');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve group standings'
    });
  }
});

/**
 * GET /api/player/seasons/:seasonId/bracket
 * Get tournament bracket for a season
 */
router.get('/seasons/:seasonId/bracket', async (req, res) => {
  try {
    const { seasonId } = req.params;
    const playerId = req.user?.userId;

    // Verify player access
    const playerInSeason = await prisma.tournamentPlayer.findFirst({
      where: {
        seasonId,
        playerId
      }
    });

    if (!playerInSeason) {
      return res.status(403).json({
        success: false,
        error: 'Access denied to this season'
      });
    }

    const bracketData = await fetchSeasonBracket({
      seasonId,
      authHeader: req.headers.authorization
    });
    if (!bracketData) {
      return res.json({
        success: true,
        data: { seasonId, stages: [], playerContext: { playerId, currentRound: null, nextMatch: null, eliminated: false, qualified: false, isChampion: false } }
      });
    }

    const playerContext = {
      playerId,
      currentRound: null,
      nextMatch: null,
      eliminated: false,
      qualified: false,
      isChampion: false
    };

    const stages = Array.isArray(bracketData?.stages) ? bracketData.stages : [];
    stages.forEach((stage) => {
      const roundLabel = normalizeRound({ round: stage.stage, stage: stage.stage });
      (stage.matches || []).forEach((match) => {
        if (match.player1Id === playerId || match.player2Id === playerId) {
          playerContext.currentRound = roundLabel;
          playerContext.qualified = true;
          const status = normalizeStatus(match.status);

          if (status === 'COMPLETED') {
            if (match.winnerId && match.winnerId !== playerId) {
              playerContext.eliminated = true;
            } else if (roundLabel === 'FINAL') {
              playerContext.isChampion = true;
            }
          } else if (!playerContext.nextMatch) {
            playerContext.nextMatch = match;
          }
        }
      });
    });

    res.json({
      success: true,
      data: {
        seasonId,
        stages,
        playerContext
      }
    });

  } catch (error) {
    logger.error({ err: error, seasonId: req.params.seasonId }, '[PlayerAPI] Failed to get bracket');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve tournament bracket'
    });
  }
});

/**
 * GET /api/player/seasons/:seasonId/leaderboard
 * Get leaderboard and progression data
 */
router.get('/seasons/:seasonId/leaderboard', async (req, res) => {
  try {
    const { seasonId } = req.params;
    const playerId = req.user?.userId;

    // Verify player access
    const playerInSeason = await prisma.tournamentPlayer.findFirst({
      where: {
        seasonId,
        playerId
      }
    });

    if (!playerInSeason) {
      return res.status(403).json({
        success: false,
        error: 'Access denied to this season'
      });
    }

    const season = await prisma.season.findUnique({
      where: { seasonId },
      select: { tournamentId: true }
    });
    if (!season?.tournamentId) {
      return res.status(404).json({ success: false, error: 'Season not found' });
    }

    const matches = await fetchSeasonMatches({
      tournamentId: season.tournamentId,
      seasonId
    });

    const groupMatches = matches
      .map((match) => ({ ...match, round: normalizeRound(match), groupLabel: getGroupLabel(match) }))
      .filter((match) => match.round === 'GROUP' && match.groupLabel);

    const groupLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const standingsByGroup = {};
    const statsByGroup = {};

    groupLabels.forEach((label) => {
      standingsByGroup[label] = [];
    });

    groupMatches.forEach((match) => {
      const label = match.groupLabel;
      if (!label) return;
      if (!statsByGroup[label]) statsByGroup[label] = new Map();

      const ensurePlayer = (pid) => {
        if (!statsByGroup[label].has(pid)) {
          statsByGroup[label].set(pid, {
            playerId: pid,
            matchesPlayed: 0,
            wins: 0,
            losses: 0,
            pointsFor: 0,
            pointsAgainst: 0
          });
        }
        return statsByGroup[label].get(pid);
      };

      const p1 = ensurePlayer(match.player1Id);
      const p2 = ensurePlayer(match.player2Id);

      if (match.winnerId || normalizeStatus(match.status) === 'COMPLETED') {
        p1.matchesPlayed += 1;
        p2.matchesPlayed += 1;
        p1.pointsFor += Number(match.player1Score || 0);
        p1.pointsAgainst += Number(match.player2Score || 0);
        p2.pointsFor += Number(match.player2Score || 0);
        p2.pointsAgainst += Number(match.player1Score || 0);

        if (match.winnerId === match.player1Id) {
          p1.wins += 1;
          p2.losses += 1;
        } else if (match.winnerId === match.player2Id) {
          p2.wins += 1;
          p1.losses += 1;
        }
      }
    });

    groupLabels.forEach((label) => {
      const stats = Array.from((statsByGroup[label] || new Map()).values());
      stats.sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        const diffA = a.pointsFor - a.pointsAgainst;
        const diffB = b.pointsFor - b.pointsAgainst;
        if (diffB !== diffA) return diffB - diffA;
        return b.pointsFor - a.pointsFor;
      });

      standingsByGroup[label] = stats.map((stat, index) => ({
        playerId: stat.playerId,
        groupLabel: label,
        groupPosition: index + 1,
        qualified: index < 2,
        matchesPlayed: stat.matchesPlayed,
        wins: stat.wins,
        losses: stat.losses
      }));
    });

    const qualifiedPlayers = groupLabels
      .flatMap((label) => standingsByGroup[label] || [])
      .filter((player) => player.qualified);

    const knockoutMatches = matches
      .map((match) => ({ ...match, round: normalizeRound(match) }))
      .filter((match) => ['R16', 'QF', 'SF', 'FINAL'].includes(match.round));

    // Build progression leaderboard
    const leaderboard = [];
    
    // Add qualified players
    qualifiedPlayers.forEach(player => {
      const knockoutProgress = getKnockoutProgress(player.playerId, knockoutMatches);
      
      leaderboard.push({
        playerId: player.playerId,
        groupLabel: player.groupLabel,
        groupPosition: player.groupPosition,
        qualified: true,
        currentRound: knockoutProgress.currentRound,
        roundsWon: knockoutProgress.roundsWon,
        eliminated: knockoutProgress.eliminated,
        isChampion: knockoutProgress.isChampion,
        isCurrentPlayer: player.playerId === playerId
      });
    });

    // Sort by progression (furthest first)
    leaderboard.sort((a, b) => {
      const roundValues = { 'FINAL': 4, 'SF': 3, 'QF': 2, 'R16': 1, 'GROUP': 0 };
      const aValue = roundValues[a.currentRound] || 0;
      const bValue = roundValues[b.currentRound] || 0;
      
      if (bValue !== aValue) return bValue - aValue;
      return a.groupLabel.localeCompare(b.groupLabel);
    });

    const bracketStatus = {
      totalMatches: knockoutMatches.length,
      completedMatches: knockoutMatches.filter((m) => normalizeStatus(m.status) === 'COMPLETED').length
    };

    res.json({
      success: true,
      data: {
        seasonId,
        leaderboard,
        bracketStatus,
        playerRank: leaderboard.findIndex(p => p.isCurrentPlayer) + 1,
        totalQualified: qualifiedPlayers.length
      }
    });

  } catch (error) {
    logger.error({ err: error, seasonId: req.params.seasonId }, '[PlayerAPI] Failed to get leaderboard');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve leaderboard'
    });
  }
});

/**
 * Helper function to get knockout progress for a player
 */
function getKnockoutProgress(playerId, knockoutMatches) {
  let currentRound = 'GROUP';
  let roundsWon = 0;
  let eliminated = false;
  let isChampion = false;

  const rounds = ['R16', 'QF', 'SF', 'FINAL'];
  
  for (const round of rounds) {
    const roundMatch = knockoutMatches.find(match => 
      normalizeRound(match) === round &&
      (match.player1Id === playerId || match.player2Id === playerId)
    );
    
    if (roundMatch) {
      currentRound = round;
      
      if (normalizeStatus(roundMatch.status) === 'COMPLETED') {
        if (roundMatch.winnerId === playerId) {
          roundsWon++;
          if (round === 'FINAL') {
            isChampion = true;
          }
        } else {
          eliminated = true;
          break;
        }
      } else {
        break; // Current round, not yet completed
      }
    }
  }

  return {
    currentRound,
    roundsWon,
    eliminated,
    isChampion
  };
}

module.exports = router;
