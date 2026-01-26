const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const { publishEvent, Topics } = require('../../../../shared/events');
const { getIO } = require('../utils/socket');
const axios = require('axios');
// AI logic removed

const prisma = new PrismaClient();

// Services URLs
const TOURNAMENT_SERVICE_URL = process.env.TOURNAMENT_SERVICE_URL || 'http://tournament-service:3000';
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'http://game-service:3000';
const MATCH_START_DELAY_MS = 40000;
const MATCH_COOLDOWN_MS = 40000;

// Season-based matchmaking controller
class SeasonMatchmakingController {

  // Join a season queue
  static async joinSeasonQueue(req, res) {
    try {
      const { seasonId } = req.params;
      const { playerId } = req.body;

      logger.info(`Player ${playerId} joining season ${seasonId} queue`);

      // Check if season exists and is active via tournament service
      const seasonResponse = await axios.get(`${TOURNAMENT_SERVICE_URL}/api/seasons/${seasonId}`);
      const season = seasonResponse.data;

      if (!season || season.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: 'Season not active for matchmaking'
        });
      }

      // Check if player is already in queue
      const existingEntry = await prisma.matchQueue.findFirst({
        where: {
          playerId,
          seasonId,
          status: 'waiting'
        }
      });

      if (existingEntry) {
        return res.status(400).json({
          success: false,
          message: 'Player already in queue'
        });
      }

      // Add player to season queue
      const queueEntry = await prisma.matchQueue.create({
        data: {
          playerId,
          seasonId,
          tournamentId: season.tournamentId,
          status: 'waiting',
          joinedAt: new Date(),
          metadata: {
            queueType: 'season_matchmaking',
            priority: 1
          }
        }
      });

      // Try to create matches if enough players
      await this.tryCreateMatches(seasonId);

      res.json({
        success: true,
        queueEntry,
        message: 'Successfully joined season queue'
      });

    } catch (error) {
      logger.error('Error joining season queue:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to join season queue'
      });
    }
  }

  // Get player's matches in a season
  static async getPlayerMatches(req, res) {
    try {
      const { seasonId, playerId } = req.params;
      const { status } = req.query;

      const whereClause = {
        seasonId,
        OR: [
          { player1Id: playerId },
          { player2Id: playerId }
        ]
      };

      // FIXED: Show both scheduled AND in_progress matches by default
      if (status) {
        whereClause.status = status;
      } else {
        // Show matches that are ready to play or currently playing
        whereClause.status = {
          in: ['scheduled', 'in_progress']
        };
      }

      const matches = await prisma.match.findMany({
        where: whereClause,
        orderBy: {
          scheduledTime: 'asc'
        }
      });

      // Get player details from player service for each match
      const matchesWithPlayers = await Promise.all(
        matches.map(async (match) => {
          try {
            // In production, fetch player details from player service
            // For now, mock the player data
            const player1 = {
              playerId: match.player1Id,
              username: `Player${match.player1Id.slice(-4)}`,
              avatar: null
            };
            const player2 = {
              playerId: match.player2Id,
              username: `Player${match.player2Id.slice(-4)}`,
              avatar: null
            };

            const now = new Date();
            const scheduledTime = match.scheduledTime ? new Date(match.scheduledTime) : new Date();
            const timeDiff = scheduledTime.getTime() - now.getTime();

            // FIXED: More permissive canPlay logic
            const canPlay = (
              (timeDiff <= 60000) && // Within 1 minute of scheduled time or past it
              (match.status === 'scheduled' || match.status === 'in_progress') &&
              !match.winnerId  // Not finished yet
            );

            // Better status display
            let displayStatus = 'upcoming';
            if (match.status === 'in_progress') {
              displayStatus = 'playing';
            } else if (match.winnerId) {
              displayStatus = 'completed';
            } else if (canPlay) {
              displayStatus = 'ready';
            }

            return {
              ...match,
              player1,
              player2,
              timeUntilStart: timeDiff > 0 ? Math.ceil(timeDiff / 1000) : 0,
              canPlay,
              displayStatus,
              isCurrentPlayer: match.player1Id === playerId || match.player2Id === playerId
            };
          } catch (error) {
            logger.error('Error enriching match data:', error);
            return match;
          }
        })
      );

      res.json({
        success: true,
        matches: matchesWithPlayers
      });

    } catch (error) {
      logger.error('Error getting player matches:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get player matches'
      });
    }
  }

  // Create scheduled matches from queue
  static async tryCreateMatches(seasonId) {
    try {
      // Get season and tournament information
      const seasonResponse = await axios.get(`${TOURNAMENT_SERVICE_URL}/api/seasons/${seasonId}`);
      const season = seasonResponse.data;

      if (!season) {
        logger.warn(`Season ${seasonId} not found`);
        return [];
      }

      // Get waiting players in queue (FIFO order)
      const waitingPlayers = await prisma.matchQueue.findMany({
        where: {
          seasonId,
          status: 'waiting'
        },
        orderBy: {
          joinedAt: 'asc'
        },
        take: 20 // Process in batches
      });

      logger.info(`Found ${waitingPlayers.length} waiting players in season ${seasonId}`);

      if (waitingPlayers.length === 0) {
        return [];
      }

      const matches = [];

      // For human vs human matches, create pairs
      if (waitingPlayers.length < 2) {
        return [];
      }

      const availablePlayers = [];
      for (const player of waitingPlayers) {
        const availability = await this.getPlayerAvailability(player.playerId);
        if (!availability.available) {
          continue;
        }
        availablePlayers.push({ ...player, nextAvailableAt: availability.nextAvailableAt });
      }

      for (let i = 0; i < availablePlayers.length - 1; i += 2) {
        const player1 = availablePlayers[i];
        const player2 = availablePlayers[i + 1];
        const scheduledTime = this.getScheduledStartTime(player1, player2);

        const match = await this.createHumanMatch(player1, player2, season, scheduledTime);
        if (match) {
          matches.push(match);

          // Update queue entries to matched
          await prisma.matchQueue.updateMany({
            where: {
              id: { in: [player1.id, player2.id] }
            },
            data: {
              status: 'matched',
              matchId: match.matchId
            }
          });
        }
      }

      if (matches.length > 0) {
        // Notify players about new matches via WebSocket
        const io = getIO();
        if (io) {
          matches.forEach(match => {
            io.to(`player:${match.player1Id}`).emit('match:scheduled', {
              match,
              message: 'New match scheduled!'
            });

            // For human vs human matches, notify both players
            if (match.player2Id) {
              io.to(`player:${match.player2Id}`).emit('match:scheduled', {
                match,
                message: 'New match scheduled!'
              });
            }
          });
        }
      }

      return matches;

    } catch (error) {
      logger.error('Error creating matches from queue:', error);
      throw error;
    }
  }

  // Create human vs human match
  static async createHumanMatch(player1, player2, season, scheduledTime) {
    try {
      const targetStart = scheduledTime || new Date(Date.now() + MATCH_START_DELAY_MS);

      const match = await prisma.match.create({
        data: {
          tournamentId: season.tournamentId,
          seasonId: season.seasonId,
          stage: 'season_queue',
          roundNumber: 1,
          player1Id: player1.playerId,
          player2Id: player2.playerId,
          status: 'scheduled',
          scheduledTime: targetStart,
          metadata: {
            matchType: 'season_queue',
            gameType: 'multiplayer',
            maxDuration: 300, // 5 minutes
            matchDurationSeconds: 300,
            createdFrom: 'season_matchmaking',
            queueGenerated: true
          }
        }
      });

      logger.info(`Created human match ${match.matchId} for players ${player1.playerId} vs ${player2.playerId}`);

      return match;

    } catch (error) {
      logger.error('Error creating human match:', error);
      return null;
    }
  }

  static getScheduledStartTime(player1, player2) {
    const now = Date.now();
    const p1Ready = player1.nextAvailableAt ? new Date(player1.nextAvailableAt).getTime() : now;
    const p2Ready = player2.nextAvailableAt ? new Date(player2.nextAvailableAt).getTime() : now;
    const startAt = Math.max(now + MATCH_START_DELAY_MS, p1Ready, p2Ready);
    return new Date(startAt);
  }

  static async getPlayerAvailability(playerId) {
    const activeMatch = await prisma.match.findFirst({
      where: {
        OR: [{ player1Id: playerId }, { player2Id: playerId }],
        status: { in: ['scheduled', 'ready', 'in_progress'] }
      },
      orderBy: { scheduledTime: 'desc' }
    });

    if (activeMatch) {
      return { available: false, nextAvailableAt: null };
    }

    const lastCompletedMatch = await prisma.match.findFirst({
      where: {
        OR: [{ player1Id: playerId }, { player2Id: playerId }],
        status: 'completed',
        completedAt: { not: null }
      },
      orderBy: { completedAt: 'desc' }
    });

    if (!lastCompletedMatch?.completedAt) {
      return { available: true, nextAvailableAt: null };
    }

    const nextAvailableAt = new Date(lastCompletedMatch.completedAt.getTime() + MATCH_COOLDOWN_MS);
    return { available: true, nextAvailableAt };
  }

  // Start a scheduled match
  static async startMatch(req, res) {
    try {
      const { matchId } = req.params;
      const { playerId, startedAt } = req.body || {};
      const requesterId = req.user?.userId;
      const requesterRole = String(req.user?.role || '').toLowerCase();

      const match = await prisma.match.findUnique({
        where: { matchId }
      });

      if (!match) {
        return res.status(404).json({
          success: false,
          message: 'Match not found'
        });
      }

      if (!requesterId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const isService = requesterRole === 'service';
      if (!isService) {
        if (!match.assignedHostPlayerUserId) {
          return res.status(403).json({
            success: false,
            message: 'Match does not have an assigned host'
          });
        }
        if (match.assignedHostPlayerUserId !== requesterId) {
          return res.status(403).json({
            success: false,
            message: 'Only the assigned host can start this match'
          });
        }
        if (match.verificationStatus !== 'verified') {
          return res.status(403).json({
            success: false,
            message: 'Match is not verified'
          });
        }
      }

      if (playerId && match.player1Id !== playerId && match.player2Id !== playerId) {
        return res.status(403).json({
          success: false,
          message: 'playerId is not part of this match'
        });
      }

      if (match.assignedHostPlayerUserId) {
        const activeHostMatch = await prisma.match.findFirst({
          where: {
            assignedHostPlayerUserId: match.assignedHostPlayerUserId,
            status: 'in_progress',
            matchId: { not: matchId }
          }
        });
        if (activeHostMatch) {
          return res.status(400).json({
            success: false,
            message: 'Host already has an active match in progress'
          });
        }
      }

      // Check if match can be started
      const now = new Date();
      const scheduledTime = match.scheduledTime ? new Date(match.scheduledTime) : new Date(0);

      if (now < scheduledTime) {
        return res.status(400).json({
          success: false,
          message: 'Match not ready to start yet',
          timeUntilStart: Math.ceil((scheduledTime.getTime() - now.getTime()) / 1000)
        });
      }

      if (match.status !== 'scheduled' && match.status !== 'ready' && match.status !== 'in_progress') {
        return res.status(400).json({
          success: false,
          message: `Match is ${match.status}, cannot start`
        });
      }

      const requestedStart = startedAt ? new Date(startedAt) : new Date();
      if (Number.isNaN(requestedStart.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid startedAt'
        });
      }
      const existingStart = match.startedAt ? new Date(match.startedAt) : null;
      const safeExistingStart = existingStart && !Number.isNaN(existingStart.getTime()) ? existingStart : null;
      const shouldUpdateStart = !safeExistingStart || requestedStart > safeExistingStart;
      const effectiveStart = shouldUpdateStart ? requestedStart : safeExistingStart;

      if (match.gameSessionId) {
        const updateData = {};
        if (shouldUpdateStart) {
          updateData.startedAt = effectiveStart;
        }
        if (match.status === 'scheduled' || match.status === 'ready') {
          updateData.status = 'in_progress';
        }
        const updatedMatch = Object.keys(updateData).length
          ? await prisma.match.update({ where: { matchId }, data: updateData })
          : match;

        let gameSession = null;
        try {
          const existingSession = await axios.get(`${GAME_SERVICE_URL}/sessions/${match.gameSessionId}`);
          gameSession = existingSession.data?.data || existingSession.data?.session || null;
          await axios.post(`${GAME_SERVICE_URL}/sessions/${match.gameSessionId}/start`, {
            startedAt: effectiveStart.toISOString()
          });
        } catch (error) {
          logger.warn({ err: error, matchId, sessionId: match.gameSessionId }, 'Failed to fetch existing game session');
        }

        const matchSessionId = updatedMatch.gameSessionId || match.gameSessionId;

        res.json({
          success: true,
          match: {
            ...updatedMatch,
            gameSessionId: matchSessionId
          },
          gameSession: gameSession || { sessionId: matchSessionId },
          redirectUrl: `/game/match/${matchId}`
        });

        const io = getIO();
        if (io) {
          io.to(`match:${matchId}`).emit('match:started', {
            matchId,
            gameSessionId: matchSessionId,
            startedAt: effectiveStart.toISOString(),
            maxDurationSeconds: Number(updatedMatch?.metadata?.matchDurationSeconds || match?.metadata?.matchDurationSeconds || 300)
          });
          if (playerId) {
            const otherPlayerId = match.player1Id === playerId ? match.player2Id : match.player1Id;
            io.to(`player:${otherPlayerId}`).emit('match:started', {
              matchId,
              gameSessionId: matchSessionId,
              message: 'Your match has started!'
            });
          }
        }

        return;
      }

      // Create game session for the match via game service
      try {
        const matchDurationSeconds = Number(match?.metadata?.matchDurationSeconds || 300);
        const sessionData = {
          player1Id: match.player1Id,
          player2Id: match.player2Id,
          metadata: {
            matchId,
            seasonId: match.seasonId,
            matchDurationSeconds,
            maxDurationSeconds: matchDurationSeconds,
            gameType: 'multiplayer',
            startTime: effectiveStart.toISOString()
          }
        };

        const gameSessionResponse = await axios.post(`${GAME_SERVICE_URL}/sessions/multiplayer`, sessionData);

        const gameSession =
          gameSessionResponse.data?.data?.session ||
          gameSessionResponse.data?.data ||
          gameSessionResponse.data?.session ||
          null;

        if (!gameSession?.sessionId) {
          logger.error('Error creating game session: missing sessionId', { matchId });
          return res.status(500).json({
            success: false,
            message: 'Failed to create game session'
          });
        }

        // Update match status
        await prisma.match.update({
          where: { matchId },
          data: {
            status: 'in_progress',
            gameSessionId: gameSession.sessionId,
            startedAt: effectiveStart
          }
        });

        // Build redirect URL based on match type
        const redirectUrl = `/game/match/${matchId}`;

        res.json({
          success: true,
          match: {
            ...match,
            status: 'in_progress',
            gameSessionId: gameSession.sessionId
          },
          gameSession,
          redirectUrl
        });

        // Notify other player (only for human vs human matches)
        const io = getIO();
        if (io) {
          io.to(`match:${matchId}`).emit('match:started', {
            matchId,
            gameSessionId: gameSession.sessionId,
            startedAt: effectiveStart.toISOString(),
            maxDurationSeconds: matchDurationSeconds
          });
          if (playerId) {
            const otherPlayerId = match.player1Id === playerId ? match.player2Id : match.player1Id;
            io.to(`player:${otherPlayerId}`).emit('match:started', {
              matchId,
              gameSessionId: gameSession.sessionId,
              message: 'Your match has started!'
            });
          }
        }

      } catch (gameServiceError) {
        logger.error('Error creating game session:', gameServiceError);
        return res.status(500).json({
          success: false,
          message: 'Failed to create game session'
        });
      }

    } catch (error) {
      logger.error('Error starting match:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to start match'
      });
    }
  }

  // Leave season queue
  static async leaveQueue(req, res) {
    try {
      const { seasonId } = req.params;
      const { playerId } = req.body;

      await prisma.matchQueue.updateMany({
        where: {
          seasonId,
          playerId,
          status: 'waiting'
        },
        data: {
          status: 'left'
        }
      });

      res.json({
        success: true,
        message: 'Left season queue'
      });

    } catch (error) {
      logger.error('Error leaving queue:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to leave queue'
      });
    }
  }

  // Get season queue status
  static async getQueueStatus(req, res) {
    try {
      const { seasonId } = req.params;

      const queueCount = await prisma.matchQueue.count({
        where: {
          seasonId,
          status: 'waiting'
        }
      });

      const recentMatches = await prisma.match.count({
        where: {
          seasonId,
          createdAt: {
            gte: new Date(Date.now() - 3600000) // Last hour
          }
        }
      });

      res.json({
        success: true,
        queueStatus: {
          playersInQueue: queueCount,
          recentMatches,
          estimatedWaitTime: queueCount > 1 ? '< 1 minute' : 'Waiting for players'
        }
      });

    } catch (error) {
      logger.error('Error getting queue status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get queue status'
      });
    }
  }
}

module.exports = SeasonMatchmakingController;
