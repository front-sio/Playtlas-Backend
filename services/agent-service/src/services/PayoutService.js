const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const logger = require('../utils/logger');

const prisma = new PrismaClient();
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002';

/**
 * PayoutService - Manages payout transactions and processing
 * 
 * Handles various payout methods:
 * - Internal wallet credits
 * - Mobile money transfers
 * - Bank transfers
 * - Manual cash payments
 */
class PayoutService {

  /**
   * Create payout transaction for agent earnings
   */
  async createPayout(clubId, agentId, periodStart, periodEnd, payoutData, userId) {
    const { method, recipientDetails, reference } = payoutData;
    
    logger.info({ 
      clubId, 
      agentId, 
      periodStart, 
      periodEnd,
      method,
      initiatedBy: userId
    }, '[PayoutService] Creating payout transaction');

    try {
      // Get finalized earnings for the period
      const earnings = await this.getFinalizedEarnings(agentId, periodStart, periodEnd);
      
      if (earnings.length === 0) {
        throw new Error('No finalized earnings found for the specified period');
      }

      // Calculate total amount
      const totalAmount = earnings.reduce((sum, earning) => sum + parseFloat(earning.totalAmount), 0);
      
      // Check minimum payout amount
      const config = await this.getClubPayoutConfig(clubId);
      if (totalAmount < parseFloat(config.minPayoutAmount)) {
        throw new Error(`Payout amount ${totalAmount} is below minimum threshold ${config.minPayoutAmount}`);
      }

      // Check for existing successful payout for this period
      const existingPayout = await prisma.payoutTransaction.findFirst({
        where: {
          agentId,
          periodStart,
          periodEnd,
          status: 'SUCCESS'
        }
      });

      if (existingPayout) {
        throw new Error('Payout already processed for this period');
      }

      // Create payout transaction
      const payout = await prisma.payoutTransaction.create({
        data: {
          clubId,
          agentId,
          periodStart,
          periodEnd,
          amount: totalAmount,
          method: method || 'WALLET',
          recipientDetails: recipientDetails || {},
          referenceId: reference || this.generatePayoutReference(),
          status: 'INITIATED',
          initiatedBy: userId
        }
      });

      // Log audit trail
      await this.logPayoutAudit('CREATED', payout, userId, {
        earningsCount: earnings.length,
        totalAmount
      });

      logger.info({ 
        payoutId: payout.transactionId,
        amount: totalAmount,
        method
      }, '[PayoutService] Payout transaction created');

      // Attempt to process the payout
      const processedPayout = await this.processPayout(payout.transactionId, userId);

      return processedPayout;

    } catch (error) {
      logger.error({ 
        err: error, 
        clubId, 
        agentId, 
        periodStart, 
        periodEnd 
      }, '[PayoutService] Failed to create payout');
      throw error;
    }
  }

  /**
   * Process a payout transaction
   */
  async processPayout(transactionId, userId) {
    logger.info({ 
      transactionId,
      processedBy: userId
    }, '[PayoutService] Processing payout transaction');

    try {
      const payout = await prisma.payoutTransaction.findUnique({
        where: { transactionId }
      });

      if (!payout) {
        throw new Error('Payout transaction not found');
      }

      if (payout.status !== 'INITIATED') {
        throw new Error(`Cannot process payout in ${payout.status} status`);
      }

      let processResult;

      // Process based on method
      switch (payout.method) {
        case 'WALLET':
          processResult = await this.processWalletPayout(payout);
          break;
        case 'MOBILE_MONEY':
          processResult = await this.processMobileMoneyPayout(payout);
          break;
        case 'BANK':
          processResult = await this.processBankPayout(payout);
          break;
        case 'CASH':
          processResult = await this.processCashPayout(payout);
          break;
        default:
          throw new Error(`Unsupported payout method: ${payout.method}`);
      }

      // Update payout status
      const updatedPayout = await prisma.payoutTransaction.update({
        where: { transactionId },
        data: {
          status: processResult.success ? 'SUCCESS' : 'FAILED',
          processedAt: new Date(),
          processedBy: userId,
          failureReason: processResult.error || null,
          referenceId: processResult.reference || payout.referenceId
        }
      });

      // Update earnings as paid if successful
      if (processResult.success) {
        await this.markEarningsAsPaid(payout.agentId, payout.periodStart, payout.periodEnd, userId);
      }

      // Log audit trail
      await this.logPayoutAudit(
        processResult.success ? 'PROCESSED_SUCCESS' : 'PROCESSED_FAILED',
        updatedPayout,
        userId,
        processResult
      );

      logger.info({ 
        transactionId,
        status: updatedPayout.status,
        success: processResult.success
      }, '[PayoutService] Payout transaction processed');

      return updatedPayout;

    } catch (error) {
      // Update payout as failed
      await prisma.payoutTransaction.update({
        where: { transactionId },
        data: {
          status: 'FAILED',
          processedAt: new Date(),
          processedBy: userId,
          failureReason: error.message,
          retryCount: prisma.raw('retry_count + 1')
        }
      });

      logger.error({ 
        err: error, 
        transactionId 
      }, '[PayoutService] Failed to process payout');
      throw error;
    }
  }

  /**
   * Process wallet payout (internal credit)
   */
  async processWalletPayout(payout) {
    try {
      // This would integrate with wallet service
      // For now, simulate successful wallet credit
      
      const walletResult = await this.creditAgentWallet(
        payout.agentId, 
        payout.amount, 
        `Agent earnings payout for ${payout.periodStart} to ${payout.periodEnd}`
      );

      return {
        success: true,
        reference: walletResult.transactionId,
        method: 'WALLET'
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        method: 'WALLET'
      };
    }
  }

  /**
   * Process mobile money payout
   */
  async processMobileMoneyPayout(payout) {
    try {
      // This would integrate with mobile money API (M-Pesa, Airtel Money, etc.)
      // For now, simulate mobile money transfer
      
      const phoneNumber = payout.recipientDetails.phoneNumber;
      if (!phoneNumber) {
        throw new Error('Phone number required for mobile money payout');
      }

      // Simulate API call
      const mobileMoneyResult = {
        success: true,
        transactionId: `MM${Date.now()}`,
        phoneNumber
      };

      return {
        success: mobileMoneyResult.success,
        reference: mobileMoneyResult.transactionId,
        method: 'MOBILE_MONEY'
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        method: 'MOBILE_MONEY'
      };
    }
  }

  /**
   * Process bank transfer payout
   */
  async processBankPayout(payout) {
    try {
      // This would integrate with banking API
      // For now, simulate bank transfer
      
      const bankDetails = payout.recipientDetails;
      if (!bankDetails.accountNumber || !bankDetails.bankCode) {
        throw new Error('Bank account details required for bank payout');
      }

      // Simulate API call
      const bankResult = {
        success: true,
        transactionId: `BT${Date.now()}`,
        accountNumber: bankDetails.accountNumber
      };

      return {
        success: bankResult.success,
        reference: bankResult.transactionId,
        method: 'BANK'
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        method: 'BANK'
      };
    }
  }

  /**
   * Process cash payout (manual)
   */
  async processCashPayout(payout) {
    try {
      // Cash payouts are manual - just mark as successful
      // In practice, this would require admin confirmation
      
      return {
        success: true,
        reference: `CASH${Date.now()}`,
        method: 'CASH',
        note: 'Manual cash payout - requires physical verification'
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        method: 'CASH'
      };
    }
  }

  /**
   * Credit agent wallet (placeholder)
   */
  async creditAgentWallet(agentId, amount, description) {
    const agent = await prisma.agentProfile.findUnique({
      where: { agentId }
    });

    if (!agent?.userId) {
      throw new Error('Agent profile not found');
    }

    let wallet = null;
    try {
      const response = await axios.get(`${WALLET_SERVICE_URL}/owner/${agent.userId}`, {
        params: { type: 'agent' }
      });
      wallet = response.data?.data || response.data;
    } catch (error) {
      if (error.response?.status !== 404) {
        throw error;
      }
    }

    if (!wallet) {
      const created = await axios.post(`${WALLET_SERVICE_URL}/create`, {
        userId: agent.userId,
        type: 'agent',
        currency: 'TZS'
      });
      wallet = created.data?.data || created.data;
    }

    if (!wallet?.walletId) {
      throw new Error('Agent wallet not available');
    }

    await axios.post(`${WALLET_SERVICE_URL}/credit`, {
      walletId: wallet.walletId,
      amount,
      description,
      balanceType: 'revenue'
    });

    return {
      transactionId: `WLT${Date.now()}`,
      agentId,
      amount,
      description,
      status: 'SUCCESS'
    };
  }

  /**
   * Get finalized earnings for a period
   */
  async getFinalizedEarnings(agentId, startDate, endDate) {
    return await prisma.agentEarningsDaily.findMany({
      where: {
        agentId,
        earningsDate: {
          gte: startDate,
          lte: endDate
        },
        status: 'FINALIZED'
      },
      orderBy: {
        earningsDate: 'asc'
      }
    });
  }

  /**
   * Mark earnings as paid
   */
  async markEarningsAsPaid(agentId, startDate, endDate, userId) {
    return await prisma.agentEarningsDaily.updateMany({
      where: {
        agentId,
        earningsDate: {
          gte: startDate,
          lte: endDate
        },
        status: 'FINALIZED'
      },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paidBy: userId
      }
    });
  }

  /**
   * Get club payout configuration
   */
  async getClubPayoutConfig(clubId) {
    let config = await prisma.clubPayoutConfig.findUnique({
      where: { clubId }
    });

    if (!config) {
      // Create default config
      config = await prisma.clubPayoutConfig.create({
        data: {
          clubId,
          minPayoutAmount: 100.00,
          autoPayoutEnabled: false,
          payoutFrequency: 'DAILY'
        }
      });
    }

    return config;
  }

  /**
   * Generate unique payout reference
   */
  generatePayoutReference() {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `PAY${timestamp}${random}`;
  }

  /**
   * Get payout transactions for an agent
   */
  async getAgentPayouts(agentId, startDate, endDate) {
    const payouts = await prisma.payoutTransaction.findMany({
      where: {
        agentId,
        createdAt: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const summary = {
      agentId,
      periodStart: startDate,
      periodEnd: endDate,
      payouts,
      totals: {
        successful: payouts.filter(p => p.status === 'SUCCESS').length,
        failed: payouts.filter(p => p.status === 'FAILED').length,
        pending: payouts.filter(p => p.status === 'INITIATED').length,
        totalAmount: payouts
          .filter(p => p.status === 'SUCCESS')
          .reduce((sum, p) => sum + parseFloat(p.amount), 0)
      }
    };

    return summary;
  }

  /**
   * Get payout transactions for a club
   */
  async getClubPayouts(clubId, startDate, endDate) {
    const payouts = await prisma.payoutTransaction.findMany({
      where: {
        clubId,
        createdAt: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Group by status and method
    const summary = {
      clubId,
      periodStart: startDate,
      periodEnd: endDate,
      payouts,
      summary: {
        byStatus: {},
        byMethod: {},
        totals: {
          count: payouts.length,
          amount: payouts
            .filter(p => p.status === 'SUCCESS')
            .reduce((sum, p) => sum + parseFloat(p.amount), 0)
        }
      }
    };

    // Calculate summaries
    payouts.forEach(payout => {
      // By status
      if (!summary.summary.byStatus[payout.status]) {
        summary.summary.byStatus[payout.status] = { count: 0, amount: 0 };
      }
      summary.summary.byStatus[payout.status].count++;
      if (payout.status === 'SUCCESS') {
        summary.summary.byStatus[payout.status].amount += parseFloat(payout.amount);
      }

      // By method
      if (!summary.summary.byMethod[payout.method]) {
        summary.summary.byMethod[payout.method] = { count: 0, amount: 0 };
      }
      summary.summary.byMethod[payout.method].count++;
      if (payout.status === 'SUCCESS') {
        summary.summary.byMethod[payout.method].amount += parseFloat(payout.amount);
      }
    });

    return summary;
  }

  /**
   * Retry failed payout
   */
  async retryPayout(transactionId, userId) {
    const payout = await prisma.payoutTransaction.findUnique({
      where: { transactionId }
    });

    if (!payout) {
      throw new Error('Payout transaction not found');
    }

    if (payout.status !== 'FAILED') {
      throw new Error('Can only retry failed payouts');
    }

    if (payout.retryCount >= 3) {
      throw new Error('Maximum retry attempts exceeded');
    }

    // Reset status to INITIATED for retry
    await prisma.payoutTransaction.update({
      where: { transactionId },
      data: {
        status: 'INITIATED',
        failureReason: null
      }
    });

    // Process again
    return await this.processPayout(transactionId, userId);
  }

  /**
   * Log payout audit trail
   */
  async logPayoutAudit(action, payout, userId, data = {}) {
    try {
      await prisma.earningsAuditLog.create({
        data: {
          clubId: payout.clubId,
          agentId: payout.agentId,
          earningsDate: null,
          action: `PAYOUT_${action}`,
          triggeredBy: userId,
          afterData: {
            transactionId: payout.transactionId,
            amount: parseFloat(payout.amount),
            method: payout.method,
            status: payout.status,
            ...data
          },
          reason: `Payout ${action.toLowerCase()} by ${userId || 'system'}`
        }
      });
    } catch (error) {
      logger.error({ err: error }, '[PayoutService] Failed to create audit log');
    }
  }

  /**
   * Generate payout report for a period
   */
  async generatePayoutReport(clubId, startDate, endDate) {
    const payouts = await this.getClubPayouts(clubId, startDate, endDate);
    
    const report = {
      clubId,
      reportPeriod: { startDate, endDate },
      generatedAt: new Date(),
      summary: payouts.summary,
      details: payouts.payouts,
      analytics: {
        successRate: payouts.summary.totals.count > 0 ? 
          (payouts.summary.byStatus.SUCCESS?.count || 0) / payouts.summary.totals.count : 0,
        averagePayoutAmount: payouts.summary.byStatus.SUCCESS?.count > 0 ? 
          payouts.summary.byStatus.SUCCESS.amount / payouts.summary.byStatus.SUCCESS.count : 0,
        preferredMethod: Object.entries(payouts.summary.byMethod)
          .sort(([,a], [,b]) => b.count - a.count)[0]?.[0] || null
      }
    };

    return report;
  }
}

module.exports = { PayoutService };
