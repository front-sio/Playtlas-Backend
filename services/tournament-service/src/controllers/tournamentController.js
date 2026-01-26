const { prisma } = require('../config/db');
const logger = require('../utils/logger');
const axios = require('axios');
const { publishEvent, Topics } = require('../../../../shared');
const { ensureTournamentSchedule, scheduleTournamentStart, cancelTournamentSchedule } = require('../jobs/schedulerQueue');
// Removed AI settings logic

const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3003';
const MATCHMAKING_SERVICE_URL = process.env.MATCHMAKING_SERVICE_URL || 'http://matchmaking-service:3009';
const FIXTURE_DELAY_MINUTES = Number(process.env.SEASON_FIXTURE_DELAY_MINUTES || 4);
const JOIN_WINDOW_MINUTES = Number(process.env.SEASON_JOIN_WINDOW_MINUTES || 30);
const DEFAULT_MATCH_DURATION_SECONDS = Number(process.env.DEFAULT_MATCH_DURATION_SECONDS || 300);

function normalizeGameType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'with_ai' || normalized === 'withai' || normalized === 'ai') {
    return 'with_ai';
  }
  return 'multiplayer';
}

function getSeasonJoiningCloseTime(seasonStartTime) {
  const fixtureTime = new Date(seasonStartTime);
  return new Date(fixtureTime.getTime() - FIXTURE_DELAY_MINUTES * 60 * 1000);
}

function buildTournamentSnapshot(tournament, extra = {}) {
  return {
    tournamentId: tournament.tournamentId,
    clubId: tournament.clubId,
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

async function fetchSeasonMatchCount({ tournamentId, seasonId }) {
  const response = await axios.get(
    `${MATCHMAKING_SERVICE_URL}/matchmaking/tournament/${encodeURIComponent(tournamentId)}/matches`,
    { params: { seasonId } }
  );
  const matches = response.data?.data?.matches || [];
  return Array.isArray(matches) ? matches.length : 0;
}

exports.createTournament = async (req, res) => {
  try {
    const { clubId, name, description, entryFee, maxPlayers, startTime, matchDuration, seasonDuration, gameType } = req.body;
    if (!clubId) {
      return res.status(400).json({ success: false, error: 'clubId is required' });
    }
    const normalizedGameType = normalizeGameType(gameType);
    const effectiveMaxPlayers = maxPlayers;
    const parsedStartTime = startTime ? new Date(startTime) : new Date(Date.now() + 3600000); // Default to 1 hour from now

    const tournament = await prisma.tournament.create({
      data: {
        clubId,
        name,
        description: description || null,
        entryFee,
        maxPlayers: effectiveMaxPlayers || undefined,
        matchDuration: matchDuration || seasonDuration || DEFAULT_MATCH_DURATION_SECONDS,
        competitionWalletId: null,
        startTime: parsedStartTime,
        status: 'upcoming',
        stage: 'registration',
        metadata: {
          // Assuming buildTournamentMetadata is defined elsewhere or should be removed
          // For now, keeping it as per the provided snippet, but it's not in the original file.
          // If buildTournamentMetadata is not defined, this will cause an error.
          // ...buildTournamentMetadata(undefined, req.user),
          gameType: normalizedGameType
        }
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
    const { status, clubId, limit = 20, offset = 0 } = req.query;

    const where = {};
    if (status) where.status = status;
    if (clubId) where.clubId = clubId;

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

    const now = new Date();
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
      let joiningClosed = season.joiningClosed;
      if (season.status === 'upcoming' && season.startTime) {
        const joiningCloseAt = getSeasonJoiningCloseTime(season.startTime);
        if (now >= joiningCloseAt) {
          joiningClosed = true;
        }
      }

      return {
        ...season,
        joiningClosed,
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

exports.stopTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { reason } = req.body;

    const existing = await prisma.tournament.findUnique({ where: { tournamentId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    if (existing.status === 'stopped') {
      return res.json({ success: true, data: existing });
    }

    const updated = await prisma.tournament.update({
      where: { tournamentId },
      data: {
        status: 'stopped',
        metadata: { ...(existing.metadata || {}), stopReason: reason || null },
        updatedAt: new Date()
      }
    });

    await cancelTournamentSchedule(tournamentId, { cancelSeasons: false });

    await publishEvent(
      Topics.TOURNAMENT_STOPPED,
      buildTournamentSnapshot(updated, { reason: reason || null }),
      tournamentId
    ).catch((err) => {
      logger.error({ err }, 'Failed to publish tournament stopped event');
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Stop tournament error:', error);
    res.status(500).json({ success: false, error: 'Failed to stop tournament' });
  }
};

exports.resumeTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const existing = await prisma.tournament.findUnique({ where: { tournamentId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    if (existing.status === 'active') {
      return res.json({ success: true, data: existing });
    }

    const updated = await prisma.tournament.update({
      where: { tournamentId },
      data: {
        status: 'active',
        startTime: existing.startTime || new Date(),
        updatedAt: new Date()
      }
    });

    await publishEvent(
      Topics.TOURNAMENT_RESUMED,
      buildTournamentSnapshot(updated),
      tournamentId
    ).catch((err) => {
      logger.error({ err }, 'Failed to publish tournament resumed event');
    });

    await ensureTournamentSchedule(tournamentId);
    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Resume tournament error:', error);
    res.status(500).json({ success: false, error: 'Failed to resume tournament' });
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

    const normalizedGameType = normalizeGameType(
      tournament?.metadata?.gameType || tournament?.gameType
    );
    const platformFeePercent = normalizedGameType === 'with_ai' ? 0.10 : 0.30;

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
        userId: playerId,
        platformFeePercent
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
    delete updateData.clubId;
    delete updateData.status; // Prevent direct status updates

    const tournament = await prisma.tournament.findUnique({
      where: { tournamentId }
    });

    if (!tournament) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    // CRITICAL: Only allow updates when tournament is stopped or upcoming
    if (tournament.status === 'active') {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot update active tournament. Stop the tournament first, then update, then resume.',
        requiresStop: true,
        currentStatus: tournament.status
      });
    }

    // Check if tournament has active seasons (additional safety check)
    if (tournament.status !== 'upcoming') {
      const activeSeasons = await prisma.season.count({
        where: { 
          tournamentId,
          status: { in: ['active', 'pending'] }
        }
      });

      if (activeSeasons > 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Cannot update tournament with active seasons. Stop the tournament first.',
          activeSeasons,
          requiresStop: true
        });
      }
    }

    // Validate maxPlayers
    if (updateData.maxPlayers !== undefined) {
      const parsedMaxPlayers = Number(updateData.maxPlayers);
      if (!Number.isFinite(parsedMaxPlayers) || parsedMaxPlayers < 2) {
        return res.status(400).json({ success: false, error: 'maxPlayers must be a number >= 2' });
      }
      if (parsedMaxPlayers < tournament.currentPlayers) {
        return res.status(400).json({ success: false, error: 'maxPlayers cannot be below current players' });
      }
      updateData.maxPlayers = Math.floor(parsedMaxPlayers);
    }

    // Validate entryFee
    if (updateData.entryFee !== undefined) {
      const parsedEntryFee = Number(updateData.entryFee);
      if (!Number.isFinite(parsedEntryFee) || parsedEntryFee < 0) {
        return res.status(400).json({ success: false, error: 'entryFee must be a number >= 0' });
      }
      updateData.entryFee = parsedEntryFee;
    }

    // Validate matchDuration
    if (updateData.matchDuration !== undefined) {
      const parsedDuration = Number(updateData.matchDuration);
      if (!Number.isFinite(parsedDuration) || parsedDuration < 60) {
        return res.status(400).json({ success: false, error: 'matchDuration must be at least 60 seconds' });
      }
      updateData.matchDuration = parsedDuration;
    }

    // Parse startTime if provided
    if (updateData.startTime) {
      try {
        updateData.startTime = new Date(updateData.startTime);
        if (isNaN(updateData.startTime.getTime())) {
          return res.status(400).json({ success: false, error: 'Invalid startTime format' });
        }
      } catch (err) {
        return res.status(400).json({ success: false, error: 'Invalid startTime format' });
      }
    }

    const updated = await prisma.tournament.update({
      where: { tournamentId },
      data: {
        ...updateData,
        updatedAt: new Date()
      }
    });

    // Reschedule start if startTime changed and tournament is upcoming
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

    logger.info({ 
      tournamentId, 
      updatedFields: Object.keys(updateData),
      previousStatus: tournament.status,
      newStatus: updated.status
    }, 'Tournament updated successfully');

    res.json({ 
      success: true, 
      data: updated,
      message: 'Tournament updated successfully. Use /resume endpoint to resume if needed.'
    });
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

exports.repairSeasonFixtures = async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    if (!['admin', 'manager', 'director', 'super_admin'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const { tournamentId, limit = 50, dryRun = false } = req.body || {};
    const where = { status: 'active' };
    if (tournamentId) where.tournamentId = tournamentId;

    const seasons = await prisma.season.findMany({
      where,
      take: Number(limit),
      include: {
        tournament: true,
        tournamentPlayers: { select: { playerId: true, status: true } }
      },
      orderBy: { startTime: 'asc' }
    });

    const results = [];
    for (const season of seasons) {
      const players = season.tournamentPlayers
        .filter((p) => p.status !== 'eliminated')
        .map((p) => p.playerId);

      if (players.length < 2) {
        results.push({
          seasonId: season.seasonId,
          tournamentId: season.tournamentId,
          playerCount: players.length,
          action: 'skipped_insufficient_players'
        });
        continue;
      }

      const matchCount = await fetchSeasonMatchCount({
        tournamentId: season.tournamentId,
        seasonId: season.seasonId
      });

      if (matchCount > 0) {
        results.push({
          seasonId: season.seasonId,
          tournamentId: season.tournamentId,
          playerCount: players.length,
          matchCount,
          action: 'skipped_has_matches'
        });
        continue;
      }

      if (dryRun) {
        results.push({
          seasonId: season.seasonId,
          tournamentId: season.tournamentId,
          playerCount: players.length,
          matchCount,
          action: 'would_repair'
        });
        continue;
      }

      const tournament = season.tournament;
      const tournamentStage =
        tournament?.stage && tournament.stage !== 'registration'
          ? tournament.stage
          : 'group';
      const matchDurationSeconds = Number(tournament?.matchDuration || DEFAULT_MATCH_DURATION_SECONDS);
      const seasonStartTime = season.startTime ? season.startTime.toISOString() : undefined;
      const gameType = normalizeGameType(tournament?.metadata?.gameType);
      const aiSettings = gameType === 'with_ai' ? computeAiSettings(tournament?.entryFee) : null;
      const aiDifficulty = tournament?.metadata?.aiDifficulty ?? aiSettings?.aiDifficulty ?? null;
      const level = tournament?.metadata?.level ?? aiSettings?.level ?? null;
      const aiRating = tournament?.metadata?.aiRating ?? aiSettings?.aiRating ?? null;

      await prisma.season.update({
        where: { seasonId: season.seasonId },
        data: { status: 'pending', matchesGenerated: false, errorReason: 'repair_trigger' }
      });

      await publishEvent(
        Topics.GENERATE_MATCHES,
        {
          tournamentId: season.tournamentId,
          seasonId: season.seasonId,
          clubId: season.clubId || tournament?.clubId || null,
          stage: tournamentStage,
          players,
          matchDurationSeconds,
          entryFee: Number(tournament?.entryFee || 0),
          startTime: seasonStartTime,
          gameType,
          aiDifficulty,
          aiRating,
          level
        },
        season.seasonId
      );

      logger.info(
        {
          seasonId: season.seasonId,
          tournamentId: season.tournamentId,
          playerCount: players.length,
          matchesCreated: matchCount
        },
        '[repairSeasonFixtures] Triggered match generation'
      );

      results.push({
        seasonId: season.seasonId,
        tournamentId: season.tournamentId,
        playerCount: players.length,
        matchCount,
        action: 'repair_triggered'
      });
    }

    res.json({ success: true, data: { total: results.length, results } });
  } catch (error) {
    logger.error({ err: error }, '[repairSeasonFixtures] Failed to repair seasons');
    res.status(500).json({ success: false, error: 'Failed to repair seasons' });
  }
};
