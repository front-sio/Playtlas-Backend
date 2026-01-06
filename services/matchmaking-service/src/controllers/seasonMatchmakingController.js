const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const { publishEvent, Topics } = require('../../../../shared/events');
const { getIO } = require('../utils/socket');
const axios = require('axios');

const prisma = new PrismaClient();

// Services URLs
const TOURNAMENT_SERVICE_URL = process.env.TOURNAMENT_SERVICE_URL || 'http://tournament-service:3000';
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'http://game-service:3000';

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
      
      if (status) {
        whereClause.status = status;
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
            
            return {
              ...match,
              player1,
              player2,
              timeUntilStart: timeDiff > 0 ? Math.ceil(timeDiff / 1000) : 0,
              canPlay: timeDiff <= 0 && match.status === 'scheduled',
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
      
      if (waitingPlayers.length < 2) {
        return; // Need at least 2 players for a match
      }
      
      // Create matches in pairs
      const matches = [];
      for (let i = 0; i < waitingPlayers.length - 1; i += 2) {
        const player1 = waitingPlayers[i];
        const player2 = waitingPlayers[i + 1];
        
        // Schedule match for near-immediate start
        const scheduledTime = new Date(Date.now() + (matches.length * 30000)); // 30sec intervals
        
        const match = await prisma.match.create({
          data: {
            tournamentId: player1.tournamentId,
            seasonId,
            stage: 'season_queue', // Special stage for queue matches
            roundNumber: 1,
            player1Id: player1.playerId,
            player2Id: player2.playerId,
            status: 'scheduled',
            scheduledTime,
            metadata: {
              matchType: 'season_queue',
              maxDuration: 300, // 5 minutes
              createdFrom: 'season_matchmaking',
              queueGenerated: true
            }
          }
        });
        
        // Update queue entries to matched
        await prisma.matchQueue.updateMany({
          where: {
            seasonId,
            playerId: {
              in: [player1.playerId, player2.playerId]
            }
          },
          data: {
            status: 'matched',
            matchId: match.matchId
          }
        });
        
        matches.push(match);
        
        logger.info(`Created match ${match.matchId} for players ${player1.playerId} vs ${player2.playerId}`);
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
            io.to(`player:${match.player2Id}`).emit('match:scheduled', {
              match,
              message: 'New match scheduled!'
            });
          });
        }
      }
      
      return matches;
      
    } catch (error) {
      logger.error('Error creating matches from queue:', error);
      throw error;
    }
  }
  
  // Start a scheduled match
  static async startMatch(req, res) {
    try {
      const { matchId } = req.params;
      const { playerId } = req.body;
      
      const match = await prisma.match.findUnique({
        where: { matchId }
      });
      
      if (!match) {
        return res.status(404).json({
          success: false,
          message: 'Match not found'
        });
      }
      
      // Verify player is part of this match
      if (match.player1Id !== playerId && match.player2Id !== playerId) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized for this match'
        });
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
      
      if (match.status !== 'scheduled') {
        return res.status(400).json({
          success: false,
          message: `Match is ${match.status}, cannot start`
        });
      }
      
      // Create game session for the match via game service
      try {
        const gameSessionResponse = await axios.post(`${GAME_SERVICE_URL}/api/sessions`, {
          sessionId: `match-${matchId}-${Date.now()}`,
          player1Id: match.player1Id,
          player2Id: match.player2Id,
          metadata: {
            matchId,
            seasonId: match.seasonId,
            maxDuration: 300, // 5 minutes
            gameType: 'season_match'
          }
        });
        
        const gameSession = gameSessionResponse.data.session;
        
        // Update match status
        await prisma.match.update({
          where: { matchId },
          data: {
            status: 'in_progress',
            gameSessionId: gameSession.sessionId,
            startedAt: new Date()
          }
        });
        
        res.json({
          success: true,
          match: {
            ...match,
            status: 'in_progress',
            gameSessionId: gameSession.sessionId
          },
          gameSession,
          redirectUrl: `/8ball-match?matchId=${matchId}&sessionId=${gameSession.sessionId}&playerId=${playerId}&token=match-token-${Date.now()}`
        });
        
        // Notify other player
        const io = getIO();
        if (io) {
          const otherPlayerId = match.player1Id === playerId ? match.player2Id : match.player1Id;
          io.to(`player:${otherPlayerId}`).emit('match:started', {
            matchId,
            gameSessionId: gameSession.sessionId,
            message: 'Your match has started!'
          });
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