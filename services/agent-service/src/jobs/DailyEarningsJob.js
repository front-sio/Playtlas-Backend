const { EarningsService } = require('../services/EarningsService');
const { PayoutService } = require('../services/PayoutService');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();
let cron = null;
try {
  cron = require('node-cron');
} catch (error) {
  logger.warn('[DailyEarningsJob] node-cron not available; scheduled job disabled');
}

/**
 * DailyEarningsJob - Automated daily earnings computation
 * 
 * Runs at end of each day (11:30 PM) to:
 * 1. Compute agent earnings for the day
 * 2. Optionally trigger auto-payouts
 * 3. Generate daily reports
 */
class DailyEarningsJob {

  constructor() {
    this.earningsService = new EarningsService();
    this.payoutService = new PayoutService();
    this.isRunning = false;
  }

  /**
   * Start the daily earnings computation job
   */
  start() {
    if (!cron) {
      logger.warn('[DailyEarningsJob] Skipping schedule: install node-cron to enable daily job');
      return;
    }
    logger.info('[DailyEarningsJob] Starting daily earnings computation job');

    // Run every day at 11:30 PM (after club closing time)
    cron.schedule('30 23 * * *', async () => {
      if (this.isRunning) {
        logger.warn('[DailyEarningsJob] Previous job still running, skipping...');
        return;
      }

      this.isRunning = true;
      
      try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().split('T')[0];

        logger.info({ date: dateStr }, '[DailyEarningsJob] Starting daily computation');
        
        await this.runDailyComputation(dateStr);
        
        logger.info({ date: dateStr }, '[DailyEarningsJob] Daily computation completed');

      } catch (error) {
        logger.error({ err: error }, '[DailyEarningsJob] Daily computation failed');
      } finally {
        this.isRunning = false;
      }
    }, {
      scheduled: true,
      timezone: 'Africa/Dar_es_Salaam' // Tanzania timezone
    });

    logger.info('[DailyEarningsJob] Daily earnings job scheduled for 11:30 PM daily');
  }

  /**
   * Run daily computation for a specific date
   */
  async runDailyComputation(date) {
    logger.info({ date }, '[DailyEarningsJob] Running computation for date');

    try {
      // Get all active clubs
      const activeClubs = await this.getActiveClubs();
      
      const results = [];
      
      for (const club of activeClubs) {
        try {
          logger.info({ clubId: club.clubId, date }, '[DailyEarningsJob] Processing club');
          
          // Compute earnings for this club
          const clubResult = await this.earningsService.computeDailyEarnings(
            club.clubId, 
            date, 
            'SYSTEM_JOB'
          );
          
          results.push({
            clubId: club.clubId,
            success: true,
            result: clubResult
          });

          // Check for auto-payout if enabled
          if (club.config?.autoPayoutEnabled) {
            await this.processAutoPayout(club.clubId, date);
          }

        } catch (error) {
          logger.error({ 
            err: error, 
            clubId: club.clubId, 
            date 
          }, '[DailyEarningsJob] Failed to process club');
          
          results.push({
            clubId: club.clubId,
            success: false,
            error: error.message
          });
        }
      }

      // Generate summary report
      const summary = this.generateJobSummary(date, results);
      
      // Log job completion
      await this.logJobExecution(date, summary);
      
      return summary;

    } catch (error) {
      logger.error({ err: error, date }, '[DailyEarningsJob] Failed to run daily computation');
      throw error;
    }
  }

  /**
   * Get active clubs that need earnings computation
   */
  async getActiveClubs() {
    try {
      // This would typically query the club service or database
      // For now, get clubs that have agent shifts scheduled
      
      const clubsWithActivity = await prisma.agentShift.findMany({
        where: {
          shiftDate: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
          }
        },
        select: {
          clubId: true
        },
        distinct: ['clubId']
      });

      const clubs = [];
      
      for (const { clubId } of clubsWithActivity) {
        // Get club payout configuration
        const config = await prisma.clubPayoutConfig.findUnique({
          where: { clubId }
        });
        
        clubs.push({
          clubId,
          config
        });
      }

      return clubs;

    } catch (error) {
      logger.error({ err: error }, '[DailyEarningsJob] Failed to get active clubs');
      return [];
    }
  }

  /**
   * Process automatic payout for a club
   */
  async processAutoPayout(clubId, date) {
    try {
      logger.info({ clubId, date }, '[DailyEarningsJob] Processing auto-payout');

      // Get finalized earnings for the date
      const earnings = await prisma.agentEarningsDaily.findMany({
        where: {
          clubId,
          earningsDate: date,
          status: 'FINALIZED'
        }
      });

      // Group by agent
      const agentEarnings = {};
      earnings.forEach(earning => {
        if (!agentEarnings[earning.agentId]) {
          agentEarnings[earning.agentId] = [];
        }
        agentEarnings[earning.agentId].push(earning);
      });

      // Create payouts for each agent
      for (const [agentId, agentEarningsList] of Object.entries(agentEarnings)) {
        try {
          const totalAmount = agentEarningsList.reduce((sum, e) => sum + parseFloat(e.totalAmount), 0);
          
          // Check minimum payout threshold
          const config = await prisma.clubPayoutConfig.findUnique({
            where: { clubId }
          });
          
          if (totalAmount >= parseFloat(config.minPayoutAmount)) {
            await this.payoutService.createPayout(
              clubId,
              agentId,
              date, // Single day payout
              date,
              {
                method: 'WALLET', // Default to wallet for auto-payouts
                recipientDetails: {},
                reference: null
              },
              'AUTO_PAYOUT_SYSTEM'
            );
            
            logger.info({ 
              clubId, 
              agentId, 
              amount: totalAmount 
            }, '[DailyEarningsJob] Auto-payout created');
          }
          
        } catch (error) {
          logger.error({ 
            err: error, 
            clubId, 
            agentId 
          }, '[DailyEarningsJob] Failed to create auto-payout');
        }
      }

    } catch (error) {
      logger.error({ 
        err: error, 
        clubId, 
        date 
      }, '[DailyEarningsJob] Failed to process auto-payout');
    }
  }

  /**
   * Generate job execution summary
   */
  generateJobSummary(date, results) {
    const summary = {
      executionDate: date,
      executedAt: new Date(),
      totalClubs: results.length,
      successfulClubs: results.filter(r => r.success).length,
      failedClubs: results.filter(r => !r.success).length,
      totalAgents: 0,
      totalEarnings: 0,
      results
    };

    // Calculate totals from successful results
    results.filter(r => r.success).forEach(result => {
      if (result.result?.summary) {
        summary.totalAgents += result.result.summary.totalAgents;
        summary.totalEarnings += result.result.summary.totalEarnings;
      }
    });

    return summary;
  }

  /**
   * Log job execution for audit
   */
  async logJobExecution(date, summary) {
    try {
      await prisma.earningsAuditLog.create({
        data: {
          clubId: null, // System-level log
          agentId: null,
          earningsDate: date,
          action: 'DAILY_JOB_EXECUTED',
          triggeredBy: 'SYSTEM',
          afterData: summary,
          reason: `Daily earnings computation job for ${date}`
        }
      });
    } catch (error) {
      logger.error({ err: error, date }, '[DailyEarningsJob] Failed to log job execution');
    }
  }

  /**
   * Manually run computation for a specific date (admin trigger)
   */
  async runManualComputation(date, userId) {
    logger.info({ date, userId }, '[DailyEarningsJob] Running manual computation');

    if (this.isRunning) {
      throw new Error('Daily job is already running. Please wait for completion.');
    }

    this.isRunning = true;
    
    try {
      const result = await this.runDailyComputation(date);
      
      // Log manual execution
      await prisma.earningsAuditLog.create({
        data: {
          clubId: null,
          agentId: null,
          earningsDate: date,
          action: 'MANUAL_JOB_EXECUTED',
          triggeredBy: userId,
          afterData: result,
          reason: `Manual earnings computation triggered by ${userId}`
        }
      });
      
      return result;
      
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get job status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastExecution: this.getLastExecutionTime(),
      nextExecution: this.getNextExecutionTime()
    };
  }

  /**
   * Get last execution time from audit logs
   */
  async getLastExecutionTime() {
    try {
      const lastLog = await prisma.earningsAuditLog.findFirst({
        where: {
          action: { in: ['DAILY_JOB_EXECUTED', 'MANUAL_JOB_EXECUTED'] }
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      return lastLog?.createdAt || null;
    } catch (error) {
      logger.error({ err: error }, '[DailyEarningsJob] Failed to get last execution time');
      return null;
    }
  }

  /**
   * Get next scheduled execution time
   */
  getNextExecutionTime() {
    // Calculate next 11:30 PM
    const now = new Date();
    const next = new Date(now);
    next.setHours(23, 30, 0, 0);
    
    // If it's already past 11:30 PM today, schedule for tomorrow
    if (now > next) {
      next.setDate(next.getDate() + 1);
    }
    
    return next;
  }

  /**
   * Stop the job (for graceful shutdown)
   */
  stop() {
    logger.info('[DailyEarningsJob] Stopping daily earnings job');
    // The cron job will be automatically cleaned up when the process exits
  }
}

module.exports = { DailyEarningsJob };
