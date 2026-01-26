const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const logger = require('../utils/logger');
const { getServiceToken } = require('../utils/serviceAuth');

const prisma = new PrismaClient();

/**
 * MatchScheduler - Handles device routing and time slot allocation
 * 
 * Scheduling Rules:
 * - Club operates 11:00 AM to 11:00 PM (12 hours)
 * - Each match duration: 5 minutes
 * - No overlapping matches on same device
 * - Balance load across all available devices
 * - Group matches mixed across devices
 * - Knockout matches respect dependencies
 */
class MatchScheduler {

  /**
   * Schedule all matches for a season
   */
  async scheduleSeasonMatches(seasonId) {
    logger.info({ seasonId }, '[MatchScheduler] Starting season scheduling');

    const season = await prisma.season.findUnique({
      where: { seasonId },
      include: {
        tournament: true,
        matches: {
          where: { status: 'SCHEDULED' },
          orderBy: { matchNumber: 'asc' }
        }
      }
    });

    if (!season) {
      throw new Error('Season not found');
    }

    // Get available devices for this club
    const devices = await this.getAvailableDevices(season.clubId);
    if (!devices.length) {
      throw new Error('Club has no online devices available for scheduling');
    }

    // Get club operating hours
    const operatingHours = this.parseOperatingHours(
      season.tournament.operatingHoursStart,
      season.tournament.operatingHoursEnd
    );

    const matchDuration = season.tournament.matchDurationMinutes || 5;

    // Schedule group stage matches first
    const groupMatches = season.matches.filter(m => m.round === 'GROUP');
    const knockoutMatches = season.matches.filter(m => m.round !== 'GROUP');

    // Schedule group matches (can be done immediately)
    await this.scheduleGroupMatches(groupMatches, devices, operatingHours, matchDuration);

    // Schedule knockout matches (with dependencies)
    await this.scheduleKnockoutMatches(knockoutMatches, devices, operatingHours, matchDuration);

    // Generate device schedules for tracking
    await this.generateDeviceSchedules(season.clubId, devices);

    logger.info({ 
      seasonId,
      totalMatches: season.matches.length,
      devicesUsed: devices.length,
      schedulingComplete: true
    }, '[MatchScheduler] Season scheduling completed');

    return {
      scheduledMatches: season.matches.length,
      devicesUsed: devices.length,
      schedule: await this.getSeasonSchedule(seasonId)
    };
  }

  /**
   * Get available devices for a club
   */
  async getAvailableDevices(clubId) {
    try {
      const serviceToken = getServiceToken();
      const headers = serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {};
      const agentServiceUrl = process.env.AGENT_SERVICE_URL || 'http://localhost:3010';

      const response = await axios.get(`${agentServiceUrl}/internal/devices`, {
        params: { clubId, status: 'online' },
        headers
      });
      const devices = response.data?.data || [];

      logger.info({ 
        clubId, 
        deviceCount: devices.length 
      }, '[MatchScheduler] Retrieved available devices');

      return devices;
    } catch (error) {
      logger.error({ err: error, clubId }, '[MatchScheduler] Failed to get devices');
      throw new Error('Failed to retrieve club devices');
    }
  }

  /**
   * Parse operating hours from tournament settings
   */
  parseOperatingHours(startTime, endTime) {
    return {
      start: startTime || '11:00:00',
      end: endTime || '23:00:00',
      durationHours: 12 // 11 AM to 11 PM
    };
  }

  /**
   * Schedule group stage matches
   */
  async scheduleGroupMatches(matches, devices, operatingHours, matchDurationMinutes) {
    logger.info({ 
      matchCount: matches.length, 
      deviceCount: devices.length 
    }, '[MatchScheduler] Scheduling group matches');

    // Group matches by group label for better distribution
    const matchesByGroup = {};
    matches.forEach(match => {
      if (!matchesByGroup[match.groupLabel]) {
        matchesByGroup[match.groupLabel] = [];
      }
      matchesByGroup[match.groupLabel].push(match);
    });

    let currentTime = new Date();
    currentTime.setHours(11, 0, 0, 0); // Start at 11:00 AM today

    let deviceIndex = 0;
    const deviceSchedules = devices.map(device => ({
      ...device,
      schedule: [],
      nextAvailableTime: new Date(currentTime)
    }));

    // Distribute matches across devices in round-robin fashion
    // This ensures group matches are mixed across devices
    const allGroupMatches = [];
    const groupLabels = Object.keys(matchesByGroup).sort();
    
    // Interleave matches from different groups
    let maxGroupSize = Math.max(...Object.values(matchesByGroup).map(g => g.length));
    for (let i = 0; i < maxGroupSize; i++) {
      for (const groupLabel of groupLabels) {
        if (matchesByGroup[groupLabel][i]) {
          allGroupMatches.push(matchesByGroup[groupLabel][i]);
        }
      }
    }

    // Schedule each match
    for (const match of allGroupMatches) {
      const device = deviceSchedules[deviceIndex];
      
      // Schedule this match on current device
      const scheduledTime = new Date(device.nextAvailableTime);
      const endTime = new Date(scheduledTime);
      endTime.setMinutes(endTime.getMinutes() + matchDurationMinutes);

      // Update match with schedule
      await prisma.match.update({
        where: { matchId: match.matchId },
        data: {
          scheduledStartAt: scheduledTime,
          assignedDeviceId: device.deviceId,
          assignedAgentId: device.agentId
        }
      });

      // Update device schedule
      device.schedule.push({
        matchId: match.matchId,
        startTime: scheduledTime,
        endTime: endTime
      });
      
      device.nextAvailableTime = new Date(endTime);
      device.nextAvailableTime.setMinutes(device.nextAvailableTime.getMinutes() + 2); // 2 min buffer

      // Move to next device (round-robin)
      deviceIndex = (deviceIndex + 1) % devices.length;

      logger.debug({ 
        matchId: match.matchId,
        group: match.groupLabel,
        device: device.name,
        scheduledTime: scheduledTime.toISOString()
      }, '[MatchScheduler] Group match scheduled');
    }

    logger.info({ 
      scheduledCount: allGroupMatches.length,
      devicesUsed: deviceSchedules.filter(d => d.schedule.length > 0).length
    }, '[MatchScheduler] Group matches scheduling completed');
  }

  /**
   * Schedule knockout matches with dependency handling
   */
  async scheduleKnockoutMatches(matches, devices, operatingHours, matchDurationMinutes) {
    logger.info({ 
      matchCount: matches.length 
    }, '[MatchScheduler] Scheduling knockout matches');

    // Group knockout matches by round
    const matchesByRound = {
      'R16': matches.filter(m => m.round === 'R16'),
      'QF': matches.filter(m => m.round === 'QF'), 
      'SF': matches.filter(m => m.round === 'SF'),
      'FINAL': matches.filter(m => m.round === 'FINAL')
    };

    // Get the latest end time from group matches to know when knockouts can start
    const latestGroupMatch = await prisma.match.findFirst({
      where: { 
        seasonId: matches[0].seasonId,
        round: 'GROUP',
        scheduledStartAt: { not: null }
      },
      orderBy: { scheduledStartAt: 'desc' }
    });

    let roundStartTime = new Date();
    if (latestGroupMatch && latestGroupMatch.scheduledStartAt) {
      roundStartTime = new Date(latestGroupMatch.scheduledStartAt);
      roundStartTime.setMinutes(roundStartTime.getMinutes() + matchDurationMinutes + 30); // 30 min buffer after groups
    } else {
      roundStartTime.setHours(14, 0, 0, 0); // Default to 2 PM if no group matches
    }

    // Schedule each knockout round
    for (const round of ['R16', 'QF', 'SF', 'FINAL']) {
      const roundMatches = matchesByRound[round];
      if (roundMatches.length === 0) continue;

      logger.info({ 
        round, 
        matchCount: roundMatches.length,
        startTime: roundStartTime.toISOString()
      }, '[MatchScheduler] Scheduling knockout round');

      // Schedule matches in this round
      let deviceIndex = 0;
      for (const match of roundMatches) {
        const device = devices[deviceIndex];
        
        const scheduledTime = new Date(roundStartTime);
        
        await prisma.match.update({
          where: { matchId: match.matchId },
          data: {
            scheduledStartAt: scheduledTime,
            assignedDeviceId: device.deviceId,
            assignedAgentId: device.agentId
          }
        });

        logger.debug({ 
          matchId: match.matchId,
          round: match.round,
          device: device.name,
          scheduledTime: scheduledTime.toISOString()
        }, '[MatchScheduler] Knockout match scheduled');

        deviceIndex = (deviceIndex + 1) % devices.length;
      }

      // Move start time for next round (allow time for current round to complete)
      roundStartTime.setMinutes(roundStartTime.getMinutes() + matchDurationMinutes + 15); // 15 min buffer between rounds
    }

    logger.info('[MatchScheduler] Knockout matches scheduling completed');
  }

  /**
   * Generate device schedule entries for tracking availability
   */
  async generateDeviceSchedules(clubId, devices) {
    const scheduleEntries = [];
    
    // Get all scheduled matches for this club
    const matches = await prisma.match.findMany({
      where: { 
        clubId,
        scheduledStartAt: { not: null },
        assignedDeviceId: { not: null }
      },
      orderBy: { scheduledStartAt: 'asc' }
    });

    // Create schedule entries for each match
    for (const match of matches) {
      const startTime = match.scheduledStartAt;
      const endTime = new Date(startTime);
      endTime.setMinutes(endTime.getMinutes() + 5); // 5 minute matches

      scheduleEntries.push({
        deviceId: match.assignedDeviceId,
        clubId: clubId,
        startTime: startTime,
        endTime: endTime,
        matchId: match.matchId,
        status: 'BOOKED'
      });
    }

    // Bulk create schedule entries
    await prisma.deviceSchedule.createMany({
      data: scheduleEntries,
      skipDuplicates: true
    });

    logger.info({ 
      clubId, 
      scheduleEntries: scheduleEntries.length 
    }, '[MatchScheduler] Device schedules generated');
  }

  /**
   * Get complete season schedule
   */
  async getSeasonSchedule(seasonId) {
    const schedule = await prisma.match.findMany({
      where: { seasonId },
      orderBy: { scheduledStartAt: 'asc' },
      include: {
        season: true,
        tournament: true
      }
    });

    return {
      seasonId,
      matches: schedule.map(match => ({
        matchId: match.matchId,
        round: match.round,
        groupLabel: match.groupLabel,
        matchNumber: match.matchNumber,
        player1Id: match.player1Id,
        player2Id: match.player2Id,
        scheduledStartAt: match.scheduledStartAt,
        assignedDeviceId: match.assignedDeviceId,
        assignedAgentId: match.assignedAgentId,
        status: match.status
      }))
    };
  }

  /**
   * Reschedule a specific match (for postponements, etc.)
   */
  async rescheduleMatch(matchId, newStartTime) {
    const match = await prisma.match.findUnique({
      where: { matchId }
    });

    if (!match) {
      throw new Error('Match not found');
    }

    if (match.status !== 'SCHEDULED') {
      throw new Error('Can only reschedule scheduled matches');
    }

    // Check device availability at new time
    const deviceConflict = await prisma.match.findFirst({
      where: {
        assignedDeviceId: match.assignedDeviceId,
        scheduledStartAt: {
          gte: newStartTime,
          lt: new Date(newStartTime.getTime() + 5 * 60 * 1000) // 5 minutes later
        },
        matchId: { not: matchId }
      }
    });

    if (deviceConflict) {
      throw new Error('Device not available at requested time');
    }

    // Update match schedule
    await prisma.match.update({
      where: { matchId },
      data: { scheduledStartAt: newStartTime }
    });

    // Update device schedule
    await prisma.deviceSchedule.updateMany({
      where: { matchId },
      data: { 
        startTime: newStartTime,
        endTime: new Date(newStartTime.getTime() + 5 * 60 * 1000)
      }
    });

    logger.info({ 
      matchId, 
      newStartTime: newStartTime.toISOString() 
    }, '[MatchScheduler] Match rescheduled');

    return match;
  }

  /**
   * Get device utilization report
   */
  async getDeviceUtilization(clubId, startDate, endDate) {
    const schedules = await prisma.deviceSchedule.findMany({
      where: {
        clubId,
        startTime: { gte: startDate },
        endTime: { lte: endDate }
      }
    });

    const utilization = {};
    
    schedules.forEach(schedule => {
      if (!utilization[schedule.deviceId]) {
        utilization[schedule.deviceId] = {
          deviceId: schedule.deviceId,
          totalMatches: 0,
          totalMinutes: 0
        };
      }
      
      utilization[schedule.deviceId].totalMatches++;
      utilization[schedule.deviceId].totalMinutes += 5; // Each match is 5 minutes
    });

    return Object.values(utilization);
  }
}

module.exports = { MatchScheduler };
