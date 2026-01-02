const { prisma } = require('../config/db.js');
const { logger } = require('../utils/logger.js');

class FraudDetectionService {
  async checkTransaction({ userId, amount, type, phoneNumber }) {
    try {
      const flags = [];

      // Check 1: Velocity checks
      const velocityCheck = await this.checkVelocity(userId, type);
      if (velocityCheck.flagged) {
        flags.push(velocityCheck);
      }

      // Check 2: Amount anomaly
      const amountCheck = await this.checkAmountAnomaly(userId, amount, type);
      if (amountCheck.flagged) {
        flags.push(amountCheck);
      }

      // Check 3: Time pattern
      const timeCheck = this.checkTimePattern();
      if (timeCheck.flagged) {
        flags.push(timeCheck);
      }

      // Check 4: Rapid deposit-withdrawal pattern
      if (type === 'withdrawal') {
        const rapidPattern = await this.checkRapidDepositWithdrawal(userId, amount);
        if (rapidPattern.flagged) {
          flags.push(rapidPattern);
        }
      }

      // Check 5: Phone number validation
      const phoneCheck = await this.checkPhoneNumberPattern(userId, phoneNumber);
      if (phoneCheck.flagged) {
        flags.push(phoneCheck);
      }

      const highestSeverity = this.getHighestSeverity(flags);

      return {
        allowed: flags.length === 0 || highestSeverity !== 'critical',
        requiresReview: highestSeverity === 'high' || highestSeverity === 'critical',
        flags,
        severity: highestSeverity || 'none'
      };
    } catch (error) {
      logger.error('Fraud detection check failed:', error);
      // Fail open for availability, but log for review
      return { allowed: true, requiresReview: true, flags: [], severity: 'unknown', error: error.message };
    }
  }

  async checkVelocity(userId, type) {
    try {
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const count =
        type === 'deposit'
          ? await prisma.deposit.count({
              where: { userId, createdAt: { gt: since } },
            })
          : await prisma.withdrawal.count({
              where: { userId, createdAt: { gt: since } },
            });
      const threshold = type === 'deposit' ? 5 : 3;

      if (count >= threshold) {
        return {
          flagged: true,
          rule: 'high_velocity',
          severity: count > threshold + 2 ? 'critical' : 'high',
          message: `${count} ${type}s in last hour (threshold: ${threshold})`,
          data: { count, threshold, type }
        };
      }

      return { flagged: false };
    } catch (error) {
      logger.error('Velocity check failed:', error);
      return { flagged: false };
    }
  }

  async checkAmountAnomaly(userId, amount, type) {
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const stats =
        type === 'deposit'
          ? await prisma.deposit.aggregate({
              where: { userId, status: 'completed', createdAt: { gt: since } },
              _avg: { amount: true },
              _max: { amount: true },
            })
          : await prisma.withdrawal.aggregate({
              where: { userId, status: 'completed', createdAt: { gt: since } },
              _avg: { amount: true },
              _max: { amount: true },
            });

      const avgAmount = Number(stats._avg.amount || 0);
      const maxAmount = Number(stats._max.amount || 0);

      // Flag if 3x average or 1.5x max previous transaction
      if (avgAmount > 0 && amount > avgAmount * 3) {
        return {
          flagged: true,
          rule: 'amount_anomaly',
          severity: amount > avgAmount * 5 ? 'high' : 'medium',
          message: `Amount ${amount} is ${(amount / avgAmount).toFixed(1)}x user's average`,
          data: { amount, avgAmount, type }
        };
      }

      if (maxAmount > 0 && amount > maxAmount * 1.5) {
        return {
          flagged: true,
          rule: 'amount_anomaly',
          severity: 'medium',
          message: `Amount exceeds previous maximum by 50%`,
          data: { amount, maxAmount, type }
        };
      }

      // Check absolute limits
      if (type === 'withdrawal' && amount > 2000000) {
        return {
          flagged: true,
          rule: 'large_withdrawal',
          severity: amount > 5000000 ? 'critical' : 'high',
          message: `Large withdrawal amount: ${amount} TZS`,
          data: { amount, type }
        };
      }

      return { flagged: false };
    } catch (error) {
      logger.error('Amount anomaly check failed:', error);
      return { flagged: false };
    }
  }

  checkTimePattern() {
    const hour = new Date().getHours();
    
    // Flag transactions between midnight and 5 AM
    if (hour >= 0 && hour < 5) {
      return {
        flagged: true,
        rule: 'suspicious_time',
        severity: 'low',
        message: 'Transaction during unusual hours (00:00 - 05:00)',
        data: { hour }
      };
    }

    return { flagged: false };
  }

  async checkRapidDepositWithdrawal(userId, withdrawalAmount) {
    try {
      const recentDeposit = await prisma.deposit.findFirst({
        where: {
          userId,
          status: 'completed',
          createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) },
        },
        orderBy: { createdAt: 'desc' },
        select: { amount: true, createdAt: true },
      });

      if (recentDeposit) {
        const depositAmount = Number(recentDeposit.amount);
        const depositTime = recentDeposit.createdAt;
        const minutesAgo = (Date.now() - depositTime.getTime()) / 60000;

        if (minutesAgo < 15 && withdrawalAmount >= depositAmount * 0.8) {
          return {
            flagged: true,
            rule: 'rapid_deposit_withdrawal',
            severity: 'high',
            message: `Withdrawal ${minutesAgo.toFixed(0)}min after deposit of similar amount`,
            data: { depositAmount, withdrawalAmount, minutesAgo }
          };
        }
      }

      return { flagged: false };
    } catch (error) {
      logger.error('Rapid deposit-withdrawal check failed:', error);
      return { flagged: false };
    }
  }

  async checkPhoneNumberPattern(userId, phoneNumber) {
    try {
      if (!phoneNumber) {
        return { flagged: false };
      }

      const [depositUsers, withdrawalUsers] = await Promise.all([
        prisma.deposit.findMany({
          where: { phoneNumber },
          select: { userId: true },
          distinct: ['userId'],
        }),
        prisma.withdrawal.findMany({
          where: { phoneNumber },
          select: { userId: true },
          distinct: ['userId'],
        }),
      ]);

      const uniqueUserIds = new Set(
        [...depositUsers, ...withdrawalUsers]
          .map((entry) => entry.userId)
          .filter((id) => id && id !== userId)
      );

      const userCount = uniqueUserIds.size;

      if (userCount >= 3) {
        return {
          flagged: true,
          rule: 'shared_phone_number',
          severity: userCount >= 5 ? 'high' : 'medium',
          message: `Phone number used by ${userCount} different accounts`,
          data: { phoneNumber: phoneNumber.slice(-4), userCount }
        };
      }

      return { flagged: false };
    } catch (error) {
      logger.error('Phone number pattern check failed:', error);
      return { flagged: false };
    }
  }

  async flagTransaction({ transactionId, transactionType, userId, flags, severity }) {
    try {
      if (!('flaggedTransaction' in prisma)) {
        logger.warn('Flagged transaction storage unavailable in Prisma client.');
        return;
      }

      for (const flag of flags) {
        await prisma.flaggedTransaction.create({
          data: {
            transactionId,
            transactionType,
            userId,
            reason: flag.message,
            severity,
            status: 'pending'
          }
        });
      }

      logger.warn('Transaction flagged for review:', {
        transactionId,
        userId,
        severity,
        flagCount: flags.length
      });
    } catch (error) {
      logger.error('Failed to flag transaction:', error);
    }
  }

  getHighestSeverity(flags) {
    const severityLevels = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };
    let highest = 'none';
    let highestLevel = 0;

    for (const flag of flags) {
      const level = severityLevels[flag.severity] || 0;
      if (level > highestLevel) {
        highest = flag.severity;
        highestLevel = level;
      }
    }

    return highest;
  }
}

module.exports = new FraudDetectionService();
