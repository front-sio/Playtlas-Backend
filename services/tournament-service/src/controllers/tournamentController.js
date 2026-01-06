const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const axios = require('axios');
const { publishEvent, Topics } = require('../../../../shared');
const { ensureTournamentSchedule, scheduleTournamentStart, cancelTournamentSchedule } = require('../jobs/schedulerQueue');

const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3000';
const FIXTURE_DELAY_MINUTES = Number(process.env.SEASON_FIXTURE_DELAY_MINUTES || 4);
const JOIN_WINDOW_MINUTES = Number(process.env.SEASON_JOIN_WINDOW_MINUTES || 30);
const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.DEFAULT_MATCH_DURATION_SECONDS || 300);

function getSeasonJoiningCloseTime(seasonStartTime) {
  const fixtureTime = new Date(seasonStartTime);
  return new Date(fixtureTime.getTime() - FIXTURE_DELAY_MINUTES * 60 * 1000);
}

function buildTournamentSnapshot(tournament, extra = {}) {
  return {
    tournamentId: tournament.tournamentId,
    name: tournament.name,
    description: tournament.description || null,
    entryFee: Number(tournament.entryFee),
    maxPlayers: tournament.maxPlayers,
    currentPlayers: tournament.currentPlayers,
    status: tournament.status,
    stage: tournament.stage,
    competitionWalletId: tournament.competitionWalletId || null,
    startTime: tournament.startTime ? tournament.startTime.toISOString() : null,
    endTime: tournament.endTime ? tournament.endTime.toISOString() : null,
    matchDuration: tournament.matchDuration,
    createdAt: tournament.createdAt ? tournament.createdAt.toISOString() : null,
    updatedAt: tournament.updatedAt ? tournament.updatedAt.toISOString() : null,
    ...extra
  };
}

exports.createTournament = async (req, res) => {
  try {
    const { name, description, entryFee, maxPlayers, startTime, matchDuration, seasonDuration } = req.body;

    const tournament = await prisma.tournament.create({
      data: {
        name,
        description,
        entryFee,
        maxPlayers,
        startTime: startTime ? new Date(startTime) : new Date(Date.now() + 3600000),
        matchDuration: matchDuration || seasonDuration || DEFAULT_MATCH_DURATION_SECONDS,
        competitionWalletId: null
      }
    });

    await scheduleTournamentStart(tournament.tournamentId, tournament.startTime);

    await publishEvent(
      Topics.TOURNAMENT_CREATED,
      buildTournamentSnapshot(tournament),
      tournament.tournamentId
    ).catch((err) => {
      logger.error({ err }, 'Failed to publish tournament created event');
    });

    logger.info(`Tournament created: ${tournament.tournamentId}`);
    res.status(201).json({ success: true, data: tournament });
  } catch (error) {
    logger.error('Create tournament error:', error);
    res.status(500).json({ success: false, error: 'Failed to create tournament' });
  }
};

exports.getTournaments = async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    
    const where = status ? { status } : {};
    
    const results = await prisma.tournament.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    res.json({ success: true, data: results });
  } catch (error) {
    logger.error('Get tournaments error:', error);
    res.status(500).json({ success: false, error: 'Failed to get tournaments' });
  }
};

exports.getTournament = async (req, res) => {
  try {
    const tournament = await prisma.tournament.findUnique({
      where: { tournamentId: req.params.tournamentId },
      include: { tournamentPlayers: true },
    });
    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });
    
    res.json({ success: true, data: tournament });
  } catch (error) {
    logger.error('Get tournament error:', error);
    res.status(500).json({ success: false, error: 'Failed to get tournament' });
  }
};

exports.getTournamentSeasons = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const userId = req.user?.userId; // Get current user ID from auth middleware

    const tournament = await prisma.tournament.findUnique({
      where: { tournamentId },
      select: { tournamentId: true }
    });
    if (!tournament) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    const seasons = await prisma.season.findMany({
      where: { tournamentId },
      orderBy: { seasonNumber: 'desc' },
      include: {
        tournamentPlayers: true
      }
    });

    // Add playerCount and hasJoined to each season
    const seasonsWithStatus = seasons.map(season => {
      const playerCount = season.tournamentPlayers.length;
      const hasJoined = userId ? season.tournamentPlayers.some(player => player.playerId === userId) : false;
      
      return {
        ...season,
        playerCount,
        hasJoined
      };
    });

    res.json({ success: true, data: seasonsWithStatus });
  } catch (error) {
    logger.error('Get tournament seasons error:', error);
    res.status(500).json({ success: false, error: 'Failed to get tournament seasons' });
  }
};

exports.getPlayerSeasons = async (req, res) => {
  try {
    const { playerId } = req.params;
    const { result } = req.query;

    if (!playerId) {
      return res.status(400).json({ success: false, error: 'playerId is required' });
    }

    const where = { playerId };
    if (result === 'won') {
      where.status = 'winner';
    }

    const entries = await prisma.tournamentPlayer.findMany({
      where,
      orderBy: { registeredAt: 'desc' },
      include: {
        season: {
          include: {
            tournament: true
          }
        }
      }
    });

    const seasons = entries
      .filter((entry) => entry.season)
      .map((entry) => ({
        ...entry.season,
        tournament: entry.season.tournament,
        playerStatus: entry.status,
        joinedAt: entry.registeredAt
      }));

    res.json({ success: true, data: seasons });
  } catch (error) {
    logger.error('Get player seasons error:', error);
    res.status(500).json({ success: false, error: 'Failed to get player seasons' });
  }
};

exports.getSeason = async (req, res) => {
  try {
    const { seasonId } = req.params;
    const userId = req.user?.userId; // Get current user ID from auth middleware

    const season = await prisma.season.findUnique({
      where: { seasonId },
      include: {
        tournament: true,
        tournamentPlayers: true
      }
    });

    if (!season) {
      return res.status(404).json({ success: false, error: 'Season not found' });
    }

    const joiningCloseAt = getSeasonJoiningCloseTime(season.startTime);
    const playerCount = season.tournamentPlayers.length;
    const hasJoined = userId ? season.tournamentPlayers.some(player => player.playerId === userId) : false;

    res.json({
      success: true,
      data: {
        ...season,
        joiningCloseAt,
        playerCount,
        hasJoined
      }
    });
  } catch (error) {
    logger.error('Get season error:', error);
    res.status(500).json({ success: false, error: 'Failed to get season' });
  }
};

exports.getTournamentStats = async (req, res) => {
  try {
    const [totalTournaments, totalPlayers, activeSeasons] = await Promise.all([
      prisma.tournament.count(),
      prisma.tournamentPlayer.count(),
      prisma.season.count({ where: { status: 'active' } })
    ]);

    const byStatus = await prisma.tournament.groupBy({
      by: ['status'],
      _count: { _all: true }
    });

    const statusCounts = byStatus.reduce((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        totalTournaments,
        totalPlayers,
        activeSeasons,
        statusCounts
      }
    });
  } catch (error) {
    logger.error('Tournament stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournament stats' });
  }
};

exports.cancelTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { reason } = req.body;

    const existing = await prisma.tournament.findUnique({ where: { tournamentId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    if (existing.status === 'cancelled') {
      return res.json({ success: true, data: existing });
    }

    const updated = await prisma.tournament.update({
      where: { tournamentId },
      data: {
        status: 'cancelled',
        stage: 'cancelled',
        metadata: { ...(existing.metadata || {}), cancelReason: reason || null },
        updatedAt: new Date()
      }
    });

    await cancelTournamentSchedule(tournamentId);

    await publishEvent(
      Topics.TOURNAMENT_CANCELLED,
      buildTournamentSnapshot(updated, { reason: reason || null }),
      tournamentId
    ).catch((err) => {
      logger.error({ err }, 'Failed to publish tournament cancelled event');
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Cancel tournament error:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel tournament' });
  }
};

exports.joinSeason = async (req, res) => {
  try {
    const { seasonId } = req.params;
    const { playerId, playerWalletId } = req.body;

    if (!playerId || !playerWalletId) {
      return res.status(400).json({ success: false, error: 'playerId and playerWalletId are required' });
    }

    const season = await prisma.season.findUnique({
      where: { seasonId },
      include: { tournament: true }
    });
    if (!season) {
      return res.status(404).json({ success: false, error: 'Season not found' });
    }

    const tournament = season.tournament;
    if (!tournament || tournament.status !== 'active') {
      return res.status(400).json({ success: false, error: 'Tournament is not active' });
    }

    if (season.status !== 'upcoming') {
      return res.status(400).json({ success: false, error: 'Season is not accepting joins' });
    }

    const now = new Date();
    const joiningCloseAt = getSeasonJoiningCloseTime(season.startTime);
    if (season.joiningClosed || now >= joiningCloseAt) {
      return res.status(400).json({ success: false, error: 'Season joining is closed' });
    }

    // Enforce max players at the season level using tournament.maxPlayers
    const seasonPlayerCount = await prisma.tournamentPlayer.count({
      where: { seasonId }
    });
    if (seasonPlayerCount >= tournament.maxPlayers) {
      return res.status(400).json({ success: false, error: 'Season is full' });
    }

    const existing = await prisma.tournamentPlayer.findFirst({
      where: { seasonId, playerId }
    });
    if (existing) {
      return res.status(400).json({ success: false, error: 'Already joined this season' });
    }

    // Pay season entry fee via payment service (creates transaction record)
    try {
      await axios.post(`${PAYMENT_SERVICE_URL}/tournament-fee`, {
        playerWalletId,
        amount: tournament.entryFee,
        tournamentId: tournament.tournamentId,
        seasonId: season.seasonId,
        userId: playerId
      }, {
        headers: {
          'Authorization': req.headers.authorization,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
    } catch (error) {
      logger.error('Season fee payment failed:', error);
      return res.status(400).json({ success: false, error: error.response?.data?.error || 'Payment failed' });
    }

    const registration = await prisma.tournamentPlayer.create({
      data: {
        tournamentId: tournament.tournamentId,
        seasonId: season.seasonId,
        playerId,
        status: 'registered'
      }
    });

    try {
      await publishEvent(Topics.PLAYER_JOINED_SEASON, {
        tournamentId: tournament.tournamentId,
        seasonId: season.seasonId,
        playerId
      });
    } catch (eventErr) {
      logger.error('Failed to publish PLAYER_JOINED_SEASON event:', eventErr);
    }

    logger.info(`Player ${playerId} joined season ${seasonId} (tournament ${tournament.tournamentId})`);
    res.status(201).json({ success: true, data: registration });
  } catch (error) {
    logger.error('Join season error:', error);
    res.status(500).json({ success: false, error: 'Failed to join season' });
  }
};

// Backwards compatible endpoint: join "current" season (latest upcoming season for the tournament).
exports.joinTournament = async (req, res) => {
  try {
    return res.status(400).json({
      success: false,
      error: 'Players cannot join tournaments directly. Join a season instead.'
    });
  } catch (error) {
    logger.error('Join tournament error:', error);
    res.status(500).json({ success: false, error: 'Failed to join tournament' });
  }
};

exports.startTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const tournament = await prisma.tournament.findUnique({ where: { tournamentId } });
    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

    if (tournament.status === 'active') {
      return res.status(400).json({ success: false, error: 'Tournament already active' });
    }

    // Mark tournament as active; seasons are joined independently.
    const updatedTournament = await prisma.tournament.update({
      where: { tournamentId },
      data: {
        status: 'active',
        stage: 'registration',
        startTime: new Date(),
        updatedAt: new Date()
      }
    });

    await publishEvent(
      Topics.TOURNAMENT_STARTED,
      buildTournamentSnapshot(updatedTournament),
      tournamentId
    ).catch((err) => {
      logger.error({ err }, 'Failed to publish tournament started event');
    });

    await ensureTournamentSchedule(tournamentId);
    logger.info(`Tournament ${tournamentId} started and scheduled seasons`);
    res.json({ success: true, data: { tournament: updatedTournament } });
  } catch (error) {
    logger.error('Start tournament error:', error);
    res.status(500).json({ success: false, error: 'Failed to start tournament' });
  }
};

// Admin Functions
exports.updateTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const updateData = req.body;

    // Remove fields that shouldn't be directly updated
    delete updateData.createdAt;
    delete updateData.tournamentId;
    delete updateData.competitionWalletId;

    const tournament = await prisma.tournament.findUnique({
      where: { tournamentId }
    });

    if (!tournament) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    const updated = await prisma.tournament.update({
      where: { tournamentId },
      data: {
        ...updateData,
        updatedAt: new Date()
      }
    });

    if (updateData.startTime && updated.status === 'upcoming') {
      await scheduleTournamentStart(updated.tournamentId, updated.startTime);
    }

    await publishEvent(
      Topics.TOURNAMENT_UPDATED,
      buildTournamentSnapshot(updated),
      tournamentId
    ).catch((err) => {
      logger.error({ err }, 'Failed to publish tournament updated event');
    });

    logger.info(`Tournament updated: ${tournamentId}`);
    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Update tournament error:', error);
    res.status(500).json({ success: false, error: 'Failed to update tournament' });
  }
};

exports.deleteTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const tournament = await prisma.tournament.findUnique({
      where: { tournamentId },
      include: {
        seasons: true,
        tournamentPlayers: true
      }
    });

    if (!tournament) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    // Check if tournament can be deleted
    if (tournament.status === 'active') {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete active tournament. Cancel it first.' 
      });
    }

    await publishEvent(
      Topics.TOURNAMENT_DELETED,
      buildTournamentSnapshot(tournament, { status: 'deleted', deletedAt: new Date().toISOString() }),
      tournamentId
    ).catch((err) => {
      logger.error({ err }, 'Failed to publish tournament deleted event');
    });

    // Delete related records
    await prisma.$transaction(async (tx) => {
      // Delete season participants
      await tx.seasonParticipant.deleteMany({
        where: {
          season: {
            tournamentId
          }
        }
      });

      // Delete fixtures
      await tx.fixture.deleteMany({
        where: {
          season: {
            tournamentId
          }
        }
      });

      // Delete seasons
      await tx.season.deleteMany({
        where: { tournamentId }
      });

      // Delete tournament players
      await tx.tournamentPlayer.deleteMany({
        where: { tournamentId }
      });

      // Delete tournament
      await tx.tournament.delete({
        where: { tournamentId }
      });
    });

    logger.info(`Tournament deleted: ${tournamentId}`);
    res.json({ success: true, message: 'Tournament deleted successfully' });
  } catch (error) {
    logger.error('Delete tournament error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete tournament' });
  }
};
