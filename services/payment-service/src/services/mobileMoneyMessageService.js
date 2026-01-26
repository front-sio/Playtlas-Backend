const { prisma } = require('../config/db.js');
const { logger } = require('../utils/logger.js');
const TidParser = require('../utils/tidParser.js');

/**
 * Service for managing mobile money message records and TID-based lookups
 */
class MobileMoneyMessageService {
  
  /**
   * Store a mobile money SMS message and extract TID
   * @param {string} rawText - The raw SMS message text
   * @param {string|null} linkedDepositId - Optional deposit ID to link immediately
   * @returns {Object} - Created message record
   */
  static async storeMessage(rawText, linkedDepositId = null) {
    try {
      // Parse the message
      const parsed = TidParser.parseMessage(rawText);
      
      // Check if TID already exists
      const existingMessage = await prisma.mobileMoneyMessage.findFirst({
        where: {
          provider: parsed.provider,
          tid: parsed.tid
        }
      });

      if (existingMessage) {
        // Update status to DUPLICATE if not already processed
        if (existingMessage.status === 'NEW') {
          await prisma.mobileMoneyMessage.update({
            where: { messageId: existingMessage.messageId },
            data: { status: 'DUPLICATE' }
          });
        }
        throw new Error(`TID ${parsed.tid} already exists with status: ${existingMessage.status}`);
      }

      // Create new message record
      const messageData = {
        provider: parsed.provider,
        rawText: parsed.rawText,
        tid: parsed.tid,
        amount: parsed.amount,
        fee: parsed.fee,
        msisdn: parsed.msisdn,
        direction: parsed.direction,
        receivedAt: new Date(), // Could parse from SMS if timestamp is available
        linkedDepositId,
        status: linkedDepositId ? 'LINKED' : 'NEW'
      };

      const message = await prisma.mobileMoneyMessage.create({
        data: messageData
      });

      if (linkedDepositId) {
        try {
          await prisma.deposit.update({
            where: { depositId: linkedDepositId },
            data: { providerTid: parsed.tid }
          });
        } catch (updateError) {
          logger.warn({ err: updateError, depositId: linkedDepositId }, 'Failed to update deposit with provider TID');
        }
      }

      logger.info({ 
        messageId: message.messageId, 
        tid: parsed.tid, 
        provider: parsed.provider, 
        amount: parsed.amount 
      }, 'Mobile money message stored');

      return {
        success: true,
        data: message,
        parsed
      };

    } catch (error) {
      logger.error('Store message error:', error);
      throw error;
    }
  }

  /**
   * Search for messages by TID
   * @param {string} tid - Transaction ID to search for
   * @returns {Array} - Array of matching messages
   */
  static async searchByTid(tid) {
    try {
      if (!tid || typeof tid !== 'string') {
        throw new Error('TID is required');
      }

      // Normalize the TID
      const normalizedTid = tid.toUpperCase().trim();
      
      if (!TidParser.isValidTid(normalizedTid)) {
        throw new Error('Invalid TID format');
      }

      const messages = await prisma.mobileMoneyMessage.findMany({
        where: {
          tid: normalizedTid
        },
        include: {
          _count: {
            select: { linkedDepositId: true }
          }
        },
        orderBy: { createdAt: 'desc' }
      });

      // Also get linked deposit information if available
      const enrichedMessages = await Promise.all(
        messages.map(async (message) => {
          let linkedDeposit = null;
          if (message.linkedDepositId) {
            try {
              linkedDeposit = await prisma.deposit.findUnique({
                where: { depositId: message.linkedDepositId },
                select: {
                  depositId: true,
                  userId: true,
                  amount: true,
                  status: true,
                  referenceNumber: true,
                  createdAt: true,
                  approvedAt: true,
                  approvedBy: true
                }
              });
            } catch (err) {
              logger.warn('Failed to fetch linked deposit:', err);
            }
          }

          return {
            ...message,
            linkedDeposit
          };
        })
      );

      return {
        success: true,
        data: enrichedMessages,
        count: enrichedMessages.length
      };

    } catch (error) {
      logger.error('Search by TID error:', error);
      throw error;
    }
  }

  /**
   * Attach a message to a deposit request
   * @param {string} messageId - Message ID to attach
   * @param {string} depositId - Deposit ID to attach to
   * @param {string} adminId - Admin performing the action
   * @returns {Object} - Updated message and validation results
   */
  static async attachToDeposit(messageId, depositId, adminId) {
    try {
      // Get the message
      const message = await prisma.mobileMoneyMessage.findUnique({
        where: { messageId }
      });

      if (!message) {
        throw new Error('Message not found');
      }

      // Get the deposit
      const deposit = await prisma.deposit.findUnique({
        where: { depositId }
      });

      if (!deposit) {
        throw new Error('Deposit request not found');
      }

      // Validation checks
      const validationErrors = [];

      // Check if message is already linked to another approved deposit
      if (message.linkedDepositId && message.linkedDepositId !== depositId) {
        const existingDeposit = await prisma.deposit.findUnique({
          where: { depositId: message.linkedDepositId }
        });
        if (existingDeposit && existingDeposit.status === 'approved') {
          validationErrors.push(`TID already used for approved deposit ${existingDeposit.referenceNumber}`);
        }
      }

      // Check if deposit is in appropriate status
      if (!['pending', 'pending_payment', 'pending_approval', 'manual_review'].includes(deposit.status)) {
        validationErrors.push(`Cannot attach to deposit with status: ${deposit.status}`);
      }

      // Check amount mismatch (warning, not blocking)
      const amountMismatch = message.amount && Math.abs(parseFloat(message.amount) - parseFloat(deposit.amount)) > 0.01;
      if (amountMismatch) {
        validationErrors.push({
          type: 'warning',
          message: `Amount mismatch: SMS shows ${message.amount}, deposit request is ${deposit.amount}`
        });
      }

      // If there are blocking errors, don't proceed
      const blockingErrors = validationErrors.filter(err => typeof err === 'string');
      if (blockingErrors.length > 0) {
        throw new Error(blockingErrors.join('; '));
      }

      // Update the message
      const updatedMessage = await prisma.mobileMoneyMessage.update({
        where: { messageId },
        data: {
          linkedDepositId: depositId,
          status: 'LINKED'
        }
      });

      try {
        await prisma.deposit.update({
          where: { depositId },
          data: { providerTid: message.tid }
        });
      } catch (updateError) {
        logger.warn({ err: updateError, depositId }, 'Failed to update deposit with provider TID');
      }

      // Log the attachment
      logger.info({
        messageId,
        depositId,
        tid: message.tid,
        adminId,
        amountMismatch
      }, 'Message attached to deposit');

      return {
        success: true,
        data: updatedMessage,
        validationWarnings: validationErrors.filter(err => typeof err === 'object'),
        amountMismatch
      };

    } catch (error) {
      logger.error('Attach to deposit error:', error);
      throw error;
    }
  }

  /**
   * Attach message by TID to deposit
   * @param {string} tid - Transaction ID
   * @param {string} depositId - Deposit ID to attach to
   * @param {string} adminId - Admin performing the action
   * @returns {Object} - Attachment result
   */
  static async attachByTid(tid, depositId, adminId) {
    try {
      // Find the message by TID
      const searchResult = await this.searchByTid(tid);
      
      if (!searchResult.success || searchResult.data.length === 0) {
        throw new Error(`No message found for TID: ${tid}`);
      }

      if (searchResult.data.length > 1) {
        throw new Error(`Multiple messages found for TID: ${tid}. Use specific message ID.`);
      }

      const message = searchResult.data[0];
      return await this.attachToDeposit(message.messageId, depositId, adminId);

    } catch (error) {
      logger.error('Attach by TID error:', error);
      throw error;
    }
  }

  /**
   * Approve deposit with TID validation
   * @param {string} depositId - Deposit ID to approve
   * @param {string} adminId - Admin performing the approval
   * @param {string|null} tid - Optional TID to validate against
   * @param {string|null} transactionMessage - Custom transaction message
   * @returns {Object} - Approval result
   */
  static async approveDepositWithTid(depositId, adminId, tid = null, transactionMessage = null) {
    try {
      const deposit = await prisma.deposit.findUnique({
        where: { depositId }
      });

      if (!deposit) {
        throw new Error('Deposit request not found');
      }

      let linkedMessage = null;

      // If TID is provided, verify it matches linked message or attach it
      if (tid) {
        const normalizedTid = tid.toUpperCase().trim();
        
        const searchResult = await this.searchByTid(normalizedTid);
        if (!searchResult.success || searchResult.data.length === 0) {
          throw new Error(`No SMS message found for TID: ${normalizedTid}`);
        }

        linkedMessage = searchResult.data[0];

        // If message is not linked to this deposit, link it now
        if (!linkedMessage.linkedDepositId || linkedMessage.linkedDepositId !== depositId) {
          const attachResult = await this.attachByTid(normalizedTid, depositId, adminId);
          linkedMessage = attachResult.data;
        }

        // Check for duplicate usage
        if (linkedMessage.status === 'APPROVED') {
          throw new Error(`TID ${normalizedTid} has already been used for an approved deposit`);
        }

        // Amount validation
        if (linkedMessage.amount) {
          const amountDiff = Math.abs(parseFloat(linkedMessage.amount) - parseFloat(deposit.amount));
          if (amountDiff > 0.01) {
            logger.warn({
              depositId,
              tid: normalizedTid,
              smsAmount: linkedMessage.amount,
              depositAmount: deposit.amount,
              difference: amountDiff
            }, 'Amount mismatch during TID approval');
          }
        }
      } else {
        // Check if deposit already has a linked message
        const existingMessage = await prisma.mobileMoneyMessage.findFirst({
          where: { linkedDepositId: depositId }
        });
        linkedMessage = existingMessage;
      }

      // Update message status to APPROVED
      if (linkedMessage) {
        await prisma.mobileMoneyMessage.update({
          where: { messageId: linkedMessage.messageId },
          data: { status: 'APPROVED' }
        });
      }

      logger.info({
        depositId,
        adminId,
        tid: linkedMessage?.tid,
        messageId: linkedMessage?.messageId
      }, 'Deposit approved with TID validation');

      return {
        success: true,
        linkedMessage,
        message: 'Deposit approved successfully'
      };

    } catch (error) {
      logger.error('Approve deposit with TID error:', error);
      throw error;
    }
  }

  /**
   * Get message statistics
   * @returns {Object} - Message statistics
   */
  static async getMessageStats() {
    try {
      const stats = await prisma.mobileMoneyMessage.groupBy({
        by: ['status', 'provider'],
        _count: {
          messageId: true
        }
      });

      const totalMessages = await prisma.mobileMoneyMessage.count();
      const duplicateMessages = await prisma.mobileMoneyMessage.count({
        where: { status: 'DUPLICATE' }
      });
      
      return {
        success: true,
        data: {
          total: totalMessages,
          duplicates: duplicateMessages,
          byStatus: stats
        }
      };

    } catch (error) {
      logger.error('Get message stats error:', error);
      throw error;
    }
  }

  /**
   * List messages with pagination and filtering
   * @param {Object} options - Query options
   * @returns {Object} - Paginated message list
   */
  static async listMessages(options = {}) {
    try {
      const {
        page = 1,
        limit = 20,
        status = null,
        provider = null,
        tid = null,
        hasLinkedDeposit = null
      } = options;

      const where = {};
      
      if (status) where.status = status;
      if (provider) where.provider = provider;
      if (tid) where.tid = { contains: tid.toUpperCase() };
      if (hasLinkedDeposit === true) where.linkedDepositId = { not: null };
      if (hasLinkedDeposit === false) where.linkedDepositId = null;

      const skip = (page - 1) * limit;

      const [messages, total] = await Promise.all([
        prisma.mobileMoneyMessage.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          include: {
            linkedDeposit: {
              select: {
                depositId: true,
                userId: true,
                amount: true,
                status: true,
                referenceNumber: true
              }
            }
          }
        }),
        prisma.mobileMoneyMessage.count({ where })
      ]);

      return {
        success: true,
        data: {
          messages,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      };

    } catch (error) {
      logger.error('List messages error:', error);
      throw error;
    }
  }
}

module.exports = MobileMoneyMessageService;
