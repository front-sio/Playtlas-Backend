const { prisma } = require('../config/db.js');
const { logger } = require('../utils/logger.js');
const { getProvider } = require('../providers/index.js');
const { generateReference, sanitizePhoneNumber, maskPhoneNumber } = require('../utils/security.js');
const TidParser = require('../utils/tidParser.js');
const fraudDetectionService = require('./fraudDetection.js');
const MobileMoneyMessageService = require('./mobileMoneyMessageService.js');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const socketEmitter = require('../utils/socketEmitter.js');

const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3007';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

const PERMISSIONS = {
  WALLETS_ALL: 'wallets:*',
  TRANSACTIONS_APPROVE: 'transactions:approve',
  TRANSACTIONS_ALL: 'transactions:*',
  ALL: '*'
};

const ROLE_PERMISSIONS = {
  super_admin: [PERMISSIONS.ALL],
  superuser: [PERMISSIONS.ALL],
  superadmin: [PERMISSIONS.ALL],
  admin: [
    'users:*',
    'tournaments:*',
    PERMISSIONS.WALLETS_ALL,
    'reports:*',
    'settings:*',
    'logs:read',
    'dashboard:read',
    'games:*'
  ],
  moderator: ['users:read', 'tournaments:read', 'reports:read', 'games:read', 'dashboard:read'],
  finance_manager: [
    PERMISSIONS.WALLETS_ALL,
    PERMISSIONS.TRANSACTIONS_ALL,
    'reports:financial',
    'dashboard:read',
    'tournaments:read'
  ],
  tournament_manager: ['tournaments:*', 'matches:*', 'players:read', 'games:read', 'dashboard:read'],
  game_manager: ['tournaments:*', 'games:*', 'dashboard:read'],
  game_master: ['tournaments:*', 'games:*', 'dashboard:read'],
  support: ['users:read', 'tournaments:read', 'tickets:*', 'dashboard:read'],
  staff: ['users:read', 'wallets:read', 'tournaments:read', 'games:read', 'dashboard:read'],
  manager: [
    'users:*',
    'tournaments:*',
    PERMISSIONS.WALLETS_ALL,
    'reports:*',
    'dashboard:read',
    'games:*'
  ],
  director: [
    'users:*',
    'tournaments:*',
    PERMISSIONS.WALLETS_ALL,
    'reports:*',
    'settings:*',
    'logs:read',
    'dashboard:read',
    'games:*'
  ]
};

const hasPermission = (role, permission) => {
  if (!role) return false;
  const permissions = ROLE_PERMISSIONS[String(role).toLowerCase()] || [];
  if (permissions.includes(PERMISSIONS.ALL)) return true;
  if (permissions.includes(permission)) return true;
  const [resource] = permission.split(':');
  return permissions.includes(`${resource}:*`);
};

const isApprovalRole = (role) => {
  return (
    hasPermission(role, PERMISSIONS.TRANSACTIONS_APPROVE) ||
    hasPermission(role, PERMISSIONS.TRANSACTIONS_ALL) ||
    hasPermission(role, PERMISSIONS.WALLETS_ALL) ||
    hasPermission(role, PERMISSIONS.ALL)
  );
};

// Helper function to format transaction notification messages
function formatTransactionNotification({
  referenceNumber,
  transactionType,
  amount,
  agentPhone,
  agentName,
  newBalance,
  transactionCost = 0,
  provider = 'M-PESA',
  transactionMessage = null
}) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  // If we have a transaction message from provider, use it as is
  if (transactionMessage) {
    return transactionMessage;
  }

  const action = transactionType === 'deposit' ? 'deposited to' : 'withdrawn from';
  const agentInfo = agentName ? `${agentPhone} (${agentName})` : agentPhone;
  
  return `**${referenceNumber}** Confirmed. On ${dateStr} at ${timeStr} TZS${amount.toLocaleString()}.00 ${action} your account by ${agentInfo}. New ${provider} balance is TZS${newBalance.toLocaleString()}.00. Transaction cost: TZS${transactionCost.toLocaleString()}.00.`;
}

class PaymentProcessingService {
  constructor() {
    this.adminUsersCache = {
      fetchedAt: 0,
      rolesKey: '',
      userIds: []
    };
    this.financeManagersCache = {
      fetchedAt: 0,
      userIds: []
    };
    this.serviceToken = null;
    this.serviceTokenExpiry = 0;
  }

  getServiceToken() {
    const now = Date.now();
    if (this.serviceToken && now < this.serviceTokenExpiry) {
      return this.serviceToken;
    }

    if (process.env.INTERNAL_AUTH_TOKEN) {
      this.serviceToken = process.env.INTERNAL_AUTH_TOKEN;
      this.serviceTokenExpiry = now + 10 * 60 * 1000;
      return this.serviceToken;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      logger.warn('JWT_SECRET not configured, cannot fetch admin users for notifications');
      return null;
    }

    try {
      const token = jwt.sign(
        { userId: 'system', role: 'super_admin' },
        secret,
        { expiresIn: '5m' }
      );
      this.serviceToken = token;
      this.serviceTokenExpiry = now + 4 * 60 * 1000;
      return token;
    } catch (error) {
      logger.error('Failed to create service token for admin notifications:', error);
      return null;
    }
  }

  async fetchUsersByRole(role) {
    const token = this.getServiceToken();
    if (!token) return [];

    const limit = 200;
    let offset = 0;
    let users = [];

    while (true) {
      const response = await axios.get(
        `${AUTH_SERVICE_URL}/users?role=${encodeURIComponent(role)}&limit=${limit}&offset=${offset}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000
        }
      );

      const data = response.data?.data || [];
      const pagination = response.data?.pagination || {};
      users = users.concat(data);

      if (data.length < limit || users.length >= (pagination.total || 0)) {
        break;
      }
      offset += limit;
    }

    return users;
  }

  async getAdminUserIdsForApproval() {
    const roles = Object.keys(ROLE_PERMISSIONS).filter(isApprovalRole);
    const rolesKey = roles.sort().join('|');
    const now = Date.now();

    if (
      this.adminUsersCache.rolesKey === rolesKey &&
      now - this.adminUsersCache.fetchedAt < 60 * 1000
    ) {
      return this.adminUsersCache.userIds;
    }

    try {
      const usersByRole = await Promise.all(
        roles.map(async (role) => {
          try {
            return await this.fetchUsersByRole(role);
          } catch (error) {
            logger.warn(`Failed to fetch users for role ${role}:`, error.message || error);
            return [];
          }
        })
      );

      const userIds = new Set();
      usersByRole.flat().forEach((user) => {
        if (user?.userId && user.isActive !== false) {
          userIds.add(user.userId);
        }
      });

      const result = Array.from(userIds);
      this.adminUsersCache = {
        fetchedAt: now,
        rolesKey,
        userIds: result
      };

      return result;
    } catch (error) {
      logger.error('Failed to resolve admin users for approval notifications:', error);
      return [];
    }
  }

  async getFinanceManagerUserIds() {
    const now = Date.now();
    if (now - this.financeManagersCache.fetchedAt < 60 * 1000) {
      return this.financeManagersCache.userIds;
    }

    try {
      const users = await this.fetchUsersByRole('finance_manager');
      const userIds = users
        .filter((user) => user?.userId && user.isActive !== false)
        .map((user) => user.userId);

      const unique = Array.from(new Set(userIds));
      this.financeManagersCache = {
        fetchedAt: now,
        userIds: unique
      };
      return unique;
    } catch (error) {
      logger.error('Failed to resolve finance managers for transaction notifications:', error);
      return [];
    }
  }

  async notifyAdminsForApproval({ title, message, data }) {
    const userIds = await this.getFinanceManagerUserIds();
    if (!userIds.length) {
      logger.warn('No finance managers resolved for approval notifications');
      return;
    }

    try {
      await axios.post(`${NOTIFICATION_SERVICE_URL}/notification/send-bulk`, {
        userIds,
        type: 'approval',
        title,
        message,
        channel: 'in_app',
        priority: 'high',
        data: {
          ...data,
          playSound: true
        }
      }, { timeout: 8000 });
    } catch (error) {
      logger.error('Failed to send approval notifications to admins:', error);
    }
  }

  async notifyFinanceManagers({ title, message, data, includeSound = false }) {
    const userIds = await this.getFinanceManagerUserIds();
    if (!userIds.length) {
      logger.warn('No finance managers resolved for transaction notifications');
      return;
    }

    try {
      await axios.post(`${NOTIFICATION_SERVICE_URL}/notification/send-bulk`, {
        userIds,
        type: 'payment',
        title,
        message,
        channel: 'in_app',
        priority: 'high',
        data: {
          ...data,
          playSound: includeSound
        }
      }, { timeout: 8000 });
    } catch (error) {
      logger.error('Failed to send transaction notifications to finance managers:', error);
    }
  }

  async initiateDeposit({ userId, walletId, provider, phoneNumber, amount, metadata = {} }) {
    try {
      // Validate inputs
      if (amount < parseFloat(process.env.MIN_DEPOSIT_AMOUNT || 1000)) {
        throw new Error(`Minimum deposit amount is ${process.env.MIN_DEPOSIT_AMOUNT} TZS`);
      }

      if (amount > parseFloat(process.env.MAX_DEPOSIT_AMOUNT || 5000000)) {
        throw new Error(`Maximum deposit amount is ${process.env.MAX_DEPOSIT_AMOUNT} TZS`);
      }

      const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

      // Get provider config to calculate fee
      const { getProvider: getProviderConfig } = require('../config/providers.js');
      const providerConfig = getProviderConfig(provider);
      if (!providerConfig) {
        throw new Error('Invalid payment provider');
      }

      // Calculate deposit fee
      const depositFee = amount * (providerConfig.depositFeePercentage || 0);
      const totalAmount = parseFloat(amount) + parseFloat(depositFee);

      // Fraud detection
      const fraudCheck = await fraudDetectionService.checkTransaction({
        userId,
        amount: totalAmount, // Check against total amount user needs to pay
        type: 'deposit',
        phoneNumber: sanitizedPhone
      });

      if (!fraudCheck.allowed) {
        throw new Error('Transaction blocked for security reasons');
      }

      // Generate reference
      const referenceNumber = generateReference('DEP');

      // Create deposit record with fee
      const deposit = await prisma.deposit.create({
        data: {
          userId: userId,
          walletId: walletId,
          provider,
          amount,
          fee: depositFee,
          totalAmount: totalAmount,
          phoneNumber: sanitizedPhone,
          referenceNumber: referenceNumber,
          status: 'pending_payment', // User needs to make payment
          expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
          metadata: metadata
        }
      });

      const depositId = deposit.depositId;

      // Flag if needs review
      if (fraudCheck.requiresReview) {
        await fraudDetectionService.flagTransaction({
          transactionId: depositId,
          transactionType: 'deposit',
          userId,
          flags: fraudCheck.flags,
          severity: fraudCheck.severity
        });
      }

      // Log audit
      await this.logAudit({
        eventType: 'deposit_initiated',
        userId,
        referenceId: depositId,
        referenceType: 'deposit',
        amount: totalAmount,
        provider,
        status: 'pending_payment',
        details: { referenceNumber, amount, fee: depositFee, totalAmount, requiresReview: fraudCheck.requiresReview }
      });

      // Get provider service for transaction ID generation
      const providerService = getProvider(provider);
      const providerResponse = await providerService.initiateDeposit({
        phoneNumber: sanitizedPhone,
        amount: totalAmount, // User pays total amount
        referenceNumber
      });

      await prisma.deposit.update({
        where: { depositId: depositId },
        data: { externalReference: providerResponse.transactionId || '' }
      });

      logger.info('Deposit initiated successfully:', {
        depositId,
        referenceNumber,
        provider,
        amount,
        fee: depositFee,
        totalAmount
      });

      // Send notification
      this.sendNotification({
        userId,
        type: 'payment',
        title: 'Deposit Initiated',
        message: `Please complete the payment of ${totalAmount} TZS (includes ${depositFee} TZS fee) from ${maskPhoneNumber(sanitizedPhone)}`
      });

      await this.notifyFinanceManagers({
        title: 'Deposit Initiated',
        message: `User ${userId} initiated a deposit of TZS ${Number(totalAmount).toLocaleString()}. Reference: ${referenceNumber}.`,
        data: {
          userId,
          depositId,
          referenceNumber,
          amount: totalAmount,
          provider,
          status: 'pending_payment',
          actionUrl: '/admin/deposits'
        }
      });

      return {
        depositId,
        referenceNumber,
        amount: parseFloat(amount),
        fee: parseFloat(depositFee),
        totalAmount: parseFloat(totalAmount),
        provider,
        status: 'pending_payment',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        providerResponse
      };
    } catch (error) {
      logger.error('Deposit initiation failed:', error);
      throw error;
    }
  }

  async processDepositCallback({ provider, payload, signature }) {
    try {
      // Log callback
      const callbackLog = await prisma.paymentCallback.create({
        data: {
          provider,
          referenceNumber: payload.referenceNumber || 'unknown',
          callbackType: 'deposit',
          payload,
          signature: signature || '',
          isValid: true
        }
      });

      const providerService = getProvider(provider);
      const parsedCallback = providerService.parseCallback(payload);

      // Find deposit
      const deposit = await prisma.deposit.findFirst({
        where: { referenceNumber: parsedCallback.referenceNumber }
      });

      if (!deposit) {
        throw new Error('Deposit not found');
      }

      // Update deposit status
      await prisma.deposit.update({
        where: { depositId: deposit.depositId },
        data: {
          status: parsedCallback.status,
          completedAt: parsedCallback.status === 'completed' ? new Date() : null,
          callbackData: parsedCallback,
          externalReference: parsedCallback.transactionId || deposit.externalReference
        }
      });

      // Mark callback as processed
      await prisma.paymentCallback.update({
        where: { callbackId: callbackLog.callbackId },
        data: { processed: true, processedAt: new Date() }
      });

      // If completed, credit wallet
      if (parsedCallback.status === 'completed') {
        await this.creditWallet({
          walletId: deposit.walletId,
          userId: deposit.userId,
          depositId: deposit.depositId,
          amount: deposit.amount,
          referenceNumber: parsedCallback.referenceNumber,
          description: `Deposit via ${provider}`
        });

        // Log audit
        await this.logAudit({
          eventType: 'deposit_completed',
          userId: deposit.userId,
          referenceId: deposit.depositId,
          referenceType: 'deposit',
          amount: deposit.amount,
          provider,
          status: 'completed',
          details: parsedCallback
        });

        // Get updated wallet balance for notification
        let newBalance = 0;
        try {
          const walletResponse = await axios.get(`${WALLET_SERVICE_URL}/${deposit.walletId}`, {
            timeout: 5000
          });
          newBalance = walletResponse.data?.data?.balance || 0;
        } catch (error) {
          logger.error('Failed to get wallet balance for automatic deposit notification:', error);
        }

        // Format enhanced notification message
        const notificationMessage = formatTransactionNotification({
          referenceNumber: parsedCallback.referenceNumber || deposit.referenceNumber,
          transactionType: 'deposit',
          amount: parseFloat(deposit.amount),
          agentPhone: parsedCallback.senderPhone || '+255000000000',
          agentName: parsedCallback.senderName || 'M-PESA',
          newBalance: parseFloat(newBalance),
          transactionCost: parseFloat(deposit.fee || 0),
          provider: provider.toUpperCase(),
          transactionMessage: parsedCallback.transactionMessage
        });

        // Send enhanced notification with sound
        this.sendNotification({
          userId: deposit.userId,
          type: 'payment',
          title: 'Deposit Confirmed',
          message: notificationMessage,
          data: {
            depositId: deposit.depositId,
            amount: deposit.amount,
            referenceNumber: parsedCallback.referenceNumber || deposit.referenceNumber,
            provider: provider
          },
          includeSound: true
        });

        await this.notifyFinanceManagers({
          title: 'Deposit Completed',
          message: `Deposit ${parsedCallback.referenceNumber || deposit.referenceNumber} for TZS ${Number(deposit.amount).toLocaleString()} completed.`,
          data: {
            userId: deposit.userId,
            depositId: deposit.depositId,
            referenceNumber: parsedCallback.referenceNumber || deposit.referenceNumber,
            amount: deposit.amount,
            provider,
            status: 'completed',
            actionUrl: '/admin/deposits'
          }
        });
      } else {
        // Log failed audit
        await this.logAudit({
          eventType: 'deposit_completed',
          userId: deposit.userId,
          referenceId: deposit.depositId,
          referenceType: 'deposit',
          amount: deposit.amount,
          provider,
          status: 'failed',
          details: parsedCallback
        });

        // Send notification
        this.sendNotification({
          userId: deposit.userId,
          type: 'payment',
          title: 'Deposit Failed',
          message: `Your deposit of ${deposit.amount} TZS failed: ${parsedCallback.responseDesc || 'Unknown error'}`
        });
      }

      logger.info('Deposit callback processed:', {
        depositId: deposit.depositId,
        status: parsedCallback.status
      });

      return { success: true, status: parsedCallback.status };
    } catch (error) {
      logger.error('Deposit callback processing failed:', error);
      throw error;
    }
  }

  async initiateWithdrawal({ userId, walletId, methodId, amount, metadata = {}, role, withdrawalSource }) {
    try {
      logger.info('Initiating withdrawal:', { userId, walletId, methodId, amount, role });
      
      // Get payment method
      const method = await prisma.paymentMethod.findFirst({
        where: { methodId: methodId, userId: userId, isActive: true }
      });

      logger.info('Payment method lookup result:', { methodId, found: !!method });

      if (!method) {
        // Try to find the method without isActive check for debugging
        const allMethods = await prisma.paymentMethod.findMany({
          where: { userId: userId }
        });
        logger.error('Payment method not found:', { 
          userId, 
          methodId, 
          allUserMethods: allMethods.map(m => ({
            methodId: m.methodId,
            provider: m.provider,
            isActive: m.isActive
          }))
        });
        throw new Error('Payment method not found or inactive');
      }

      // Validate amount
      if (amount < parseFloat(process.env.MIN_WITHDRAWAL_AMOUNT || 5000)) {
        throw new Error(`Minimum withdrawal amount is ${process.env.MIN_WITHDRAWAL_AMOUNT} TZS`);
      }

      if (amount > parseFloat(process.env.MAX_WITHDRAWAL_AMOUNT || 10000000)) {
        throw new Error(`Maximum withdrawal amount is ${process.env.MAX_WITHDRAWAL_AMOUNT} TZS`);
      }

      // Check daily limits
      await this.checkDailyLimits(userId, amount);

      // Calculate fee
      const fee = this.calculateWithdrawalFee(amount);
      const totalDeducted = parseFloat(amount) + parseFloat(fee);

      const normalizedSource = String(withdrawalSource || metadata.withdrawalSource || 'deposit').toLowerCase();

      // Check wallet balance using the provided walletId
      const balances = await this.getWalletBalances(walletId);
      if (balances.balance < totalDeducted) {
        throw new Error(`Insufficient wallet balance. Required: ${totalDeducted}, Available: ${balances.balance}`);
      }
      if (normalizedSource === 'revenue' && balances.revenueBalance < totalDeducted) {
        throw new Error(`Insufficient revenue balance. Required: ${totalDeducted}, Available: ${balances.revenueBalance}`);
      }
      if (normalizedSource === 'deposit' && balances.depositBalance < totalDeducted) {
        throw new Error(`Insufficient deposit balance. Required: ${totalDeducted}, Available: ${balances.depositBalance}`);
      }

      // Use the provided walletId (validated by controller)
      const actualWalletId = walletId;

      // Fraud detection
      const fraudCheck = await fraudDetectionService.checkTransaction({
        userId,
        amount,
        type: 'withdrawal',
        phoneNumber: method.phoneNumber
      });

      if (!fraudCheck.allowed) {
        throw new Error('Transaction blocked for security reasons');
      }

      // All withdrawals require admin approval
      const requiresApproval = true;

      // Generate reference
      const referenceNumber = generateReference('WDR');

      // Create withdrawal record
      const withdrawal = await prisma.withdrawal.create({
        data: {
          userId: userId,
          walletId: walletId,
          methodId: methodId,
          provider: method.provider,
          amount,
          fee,
          totalDeducted: totalDeducted,
          phoneNumber: method.phoneNumber,
          referenceNumber: referenceNumber,
          status: 'pending',
          requiresApproval: requiresApproval,
          metadata: {
            ...metadata,
            withdrawalSource: normalizedSource
          }
        }
      });

      const withdrawalId = withdrawal.withdrawalId;

      // Flag if needs review
      if (fraudCheck.requiresReview) {
        await fraudDetectionService.flagTransaction({
          transactionId: withdrawalId,
          transactionType: 'withdrawal',
          userId,
          flags: fraudCheck.flags,
          severity: fraudCheck.severity
        });
      }

      // Log audit
      await this.logAudit({
        eventType: 'withdrawal_requested',
        userId,
        referenceId: withdrawalId,
        referenceType: 'withdrawal',
        amount,
        provider: method.provider,
        status: 'pending',
        details: { referenceNumber, requiresApproval, fee }
      });

      // If doesn't require approval, process immediately
      if (!requiresApproval) {
        await this.processWithdrawal(withdrawalId);
      } else {
        // Send notification to admins
        logger.warn('Withdrawal requires approval:', { withdrawalId, amount, userId });
        await this.notifyAdminsForApproval({
          title: 'Withdrawal approval required',
          message: `Withdrawal ${withdrawal.referenceNumber} for TZS ${Number(withdrawal.amount).toLocaleString()} needs approval.`,
          data: {
            withdrawalId: withdrawal.withdrawalId,
            referenceNumber: withdrawal.referenceNumber,
            amount: withdrawal.amount,
            actionUrl: '/admin/cashouts'
          }
        });

        // Emit real-time update to admins
        await socketEmitter.emitCurrentPendingStats();
      }

      // Update daily limits
      await this.updateDailyLimits(userId, 0, amount);

      return {
        withdrawalId,
        referenceNumber,
        amount,
        fee,
        totalDeducted,
        provider: method.provider,
        status: requiresApproval ? 'pending_approval' : 'processing',
        requiresApproval
      };
    } catch (error) {
      logger.error('Withdrawal initiation failed:', error);
      throw error;
    }
  }

  async processWithdrawal(withdrawalId) {
    try {
      const withdrawal = await prisma.withdrawal.findUnique({
        where: { withdrawalId: withdrawalId }
      });

      if (!withdrawal) {
        throw new Error('Withdrawal not found');
      }

      // Debit wallet first
      await this.debitWallet({
        walletId: withdrawal.walletId,
        userId: withdrawal.userId,
        withdrawalId: withdrawal.withdrawalId,
        amount: withdrawal.totalDeducted,
        referenceNumber: withdrawal.referenceNumber,
        description: `Withdrawal via ${withdrawal.provider} (includes fee: ${withdrawal.fee} TZS)`,
        source: withdrawal.metadata?.withdrawalSource || null
      });

      if (withdrawal.fee && parseFloat(withdrawal.fee) > 0) {
        const platformWalletId = process.env.PLATFORM_WALLET_ID;
        if (platformWalletId) {
          await this.creditWallet({
            walletId: platformWalletId,
            userId: 'system',
            depositId: `FEE-${withdrawal.withdrawalId}`,
            amount: withdrawal.fee,
            referenceNumber: `FEE-${withdrawal.referenceNumber}`,
            description: `Withdrawal fee from ${withdrawal.provider}`
          });
        } else {
          logger.warn('Platform wallet ID not configured, fee not credited');
        }
      }

      // Update status to 'processing' only if not already 'approved'
      if (withdrawal.status !== 'approved') {
        await prisma.withdrawal.update({
          where: { withdrawalId: withdrawalId },
          data: { status: 'processing' }
        });
      }

      // Process with provider
      const providerService = getProvider(withdrawal.provider);

      try {
        const providerResponse = await providerService.initiateWithdrawal({
          phoneNumber: withdrawal.phoneNumber,
          amount: withdrawal.amount,
          referenceNumber: withdrawal.referenceNumber
        });

        await prisma.withdrawal.update({
          where: { withdrawalId: withdrawalId },
          data: { externalReference: providerResponse.transactionId || '' }
        });

        logger.info('Withdrawal processing initiated:', {
          withdrawalId,
          referenceNumber: withdrawal.referenceNumber,
          amount: withdrawal.amount
        });

        // Get updated wallet balance and admin info for notification
        let newBalance = 0;
        let adminName = 'SYSTEM';
        let adminPhone = '+255000000000';

        try {
          const walletResponse = await axios.get(`${WALLET_SERVICE_URL}/${withdrawal.walletId}`, {
            timeout: 5000
          });
          newBalance = walletResponse.data?.data?.balance || 0;
        } catch (error) {
          logger.error('Failed to get wallet balance for withdrawal notification:', error);
        }

        // Format enhanced notification message
        const notificationMessage = formatTransactionNotification({
          referenceNumber: withdrawal.referenceNumber,
          transactionType: 'withdrawal',
          amount: parseFloat(withdrawal.amount),
          agentPhone: adminPhone,
          agentName: adminName,
          newBalance: parseFloat(newBalance),
          transactionCost: parseFloat(withdrawal.fee || 0),
          provider: withdrawal.provider.toUpperCase(),
          transactionMessage: withdrawal.transactionMessage
        });

        // Send enhanced notification with sound
        this.sendNotification({
          userId: withdrawal.userId,
          type: 'payment',
          title: 'Withdrawal Confirmed',
          message: notificationMessage,
          data: {
            withdrawalId,
            amount: withdrawal.amount,
            referenceNumber: withdrawal.referenceNumber,
            provider: withdrawal.provider
          },
          includeSound: true
        });

        await this.notifyFinanceManagers({
          title: 'Withdrawal Completed',
          message: `Withdrawal ${withdrawal.referenceNumber} for TZS ${Number(withdrawal.amount).toLocaleString()} completed.`,
          data: {
            userId: withdrawal.userId,
            withdrawalId,
            referenceNumber: withdrawal.referenceNumber,
            amount: withdrawal.amount,
            provider: withdrawal.provider,
            status: 'completed',
            actionUrl: '/admin/cashouts'
          }
        });
      } catch (providerError) {
        // Refund wallet if provider fails
        await this.creditWallet({
          walletId: withdrawal.walletId,
          userId: withdrawal.userId,
          depositId: `REFUND-${withdrawal.withdrawalId}`,
          amount: withdrawal.totalDeducted,
          referenceNumber: `REFUND-${withdrawal.referenceNumber}`,
          description: `Refund for failed withdrawal`
        });

        await prisma.withdrawal.update({
          where: { withdrawalId: withdrawalId },
          data: { status: 'failed', failureReason: providerError.message }
        });

        throw providerError;
      }
    } catch (error) {
      logger.error('Withdrawal processing failed:', error);
      throw error;
    }
  }

  calculateWithdrawalFee(amount) {
    const feePercentage = parseFloat(process.env.WITHDRAWAL_FEE_PERCENTAGE || 1) / 100;
    const minFee = parseFloat(process.env.WITHDRAWAL_MIN_FEE || 500);
    const maxFee = parseFloat(process.env.WITHDRAWAL_MAX_FEE || 10000);

    let fee = amount * feePercentage;
    fee = Math.max(fee, minFee);
    fee = Math.min(fee, maxFee);

    return fee.toFixed(2);
  }

  async checkDailyLimits(userId, withdrawalAmount) {
    const dailyLimit = parseFloat(process.env.DAILY_WITHDRAWAL_LIMIT || 20000000);

    const result = await prisma.dailyLimit.findFirst({
      where: { userId: userId, date: new Date() }
    });

    const todayTotal = parseFloat(result?.totalWithdrawals || 0);

    if (todayTotal + withdrawalAmount > dailyLimit) {
      throw new Error(`Daily withdrawal limit exceeded. Limit: ${dailyLimit} TZS, Used: ${todayTotal} TZS`);
    }
  }

  async updateDailyLimits(userId, depositAmount, withdrawalAmount) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existingLimit = await prisma.dailyLimit.findFirst({
      where: { userId: userId, date: today }
    });

    if (existingLimit) {
      await prisma.dailyLimit.update({
        where: { limitId: existingLimit.limitId },
        data: {
          totalDeposits: { increment: depositAmount },
          totalWithdrawals: { increment: withdrawalAmount },
          depositCount: { increment: depositAmount > 0 ? 1 : 0 },
          withdrawalCount: { increment: withdrawalAmount > 0 ? 1 : 0 },
          lastUpdated: new Date()
        }
      });
    } else {
      await prisma.dailyLimit.create({
        data: {
          userId: userId,
          date: today,
          totalDeposits: depositAmount,
          totalWithdrawals: withdrawalAmount,
          depositCount: depositAmount > 0 ? 1 : 0,
          withdrawalCount: withdrawalAmount > 0 ? 1 : 0
        }
      });
    }
  }

  async creditWallet({ walletId, amount, referenceNumber, description, userId, depositId }) {
    const { publishEvent, Topics } = require('../../../../shared/events');
    try {
      await publishEvent(Topics.DEPOSIT_APPROVED, {
        depositId: depositId || referenceNumber,
        walletId,
        userId,
        amount: parseFloat(amount),
        referenceNumber,
        description: description || 'Deposit approved'
      });
      logger.info({ walletId, amount, referenceNumber }, 'Published DEPOSIT_APPROVED event');
    } catch (error) {
      logger.error('Failed to publish deposit event:', error);
      throw new Error('Failed to process wallet credit');
    }
  }

  async debitWallet({ walletId, amount, referenceNumber, description, userId, withdrawalId, source }) {
    const { publishEvent, Topics } = require('../../../../shared/events');
    try {
      await publishEvent(Topics.WITHDRAWAL_APPROVED, {
        withdrawalId: withdrawalId || referenceNumber,
        walletId,
        userId,
        amount: parseFloat(amount),
        referenceNumber,
        description: description || 'Withdrawal approved',
        source
      });
      logger.info({ walletId, amount, referenceNumber }, 'Published WITHDRAWAL_APPROVED event');
    } catch (error) {
      logger.error('Failed to publish withdrawal event:', error);
      throw new Error('Failed to process wallet debit');
    }
  }

  async getUserWallet(userId) {
    try {
      // Use wallet service endpoint that auto-creates wallet if it doesn't exist
      const response = await axios.get(`${WALLET_SERVICE_URL}/owner/${userId}`, { timeout: 10000 });
      
      if (response.data && response.data.success && response.data.data) {
        return response.data.data;
      } else if (response.data && response.data.walletId) {
        return response.data;
      } else {
        logger.error('Unexpected wallet response format:', response.data);
        throw new Error('Invalid wallet response format');
      }
    } catch (error) {
      if (error.response) {
        logger.error('Wallet service error:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
        throw new Error(`Wallet service returned ${error.response.status}: ${error.response.data?.error || 'Unknown error'}`);
      } else if (error.request) {
        logger.error('No response from wallet service:', error.message);
        throw new Error('Wallet service is not responding');
      } else {
        logger.error('Get wallet error:', error.message);
        throw new Error('Failed to get wallet');
      }
    }
  }

  async getWalletBalance(walletId) {
    try {
      const response = await axios.get(`${WALLET_SERVICE_URL}/${walletId}/balance`, { timeout: 10000 });
      
      // Handle different response structures
      if (response.data && response.data.success && response.data.data) {
        // Success response with data property
        return parseFloat(response.data.data.balance || 0);
      } else if (response.data && response.data.balance !== undefined) {
        // Direct balance property
        return parseFloat(response.data.balance);
      } else {
        logger.error('Unexpected wallet balance response format:', response.data);
        throw new Error('Invalid wallet balance response format');
      }
    } catch (error) {
      if (error.response) {
        // The request was made and the server responded with a status code
        logger.error('Wallet service error:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
        throw new Error(`Wallet service returned ${error.response.status}: ${error.response.data?.error || 'Unknown error'}`);
      } else if (error.request) {
        // The request was made but no response was received
        logger.error('No response from wallet service:', error.message);
        throw new Error('Wallet service is not responding');
      } else {
        // Something happened in setting up the request
        logger.error('Wallet balance check error:', error.message);
        throw new Error('Failed to check wallet balance');
      }
    }
  }

  async getWalletBalances(walletId) {
    try {
      const response = await axios.get(`${WALLET_SERVICE_URL}/${walletId}/balance`, { timeout: 10000 });
      const data = response.data?.data || response.data || {};
      const balance = parseFloat(data.balance || 0);
      const revenueBalance = parseFloat(data.revenueBalance || 0);
      const depositBalance =
        data.depositBalance !== undefined
          ? parseFloat(data.depositBalance || 0)
          : Math.max(0, balance - revenueBalance);

      return { balance, revenueBalance, depositBalance };
    } catch (error) {
      if (error.response) {
        logger.error('Wallet service error:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
        throw new Error(`Wallet service returned ${error.response.status}: ${error.response.data?.error || 'Unknown error'}`);
      } else if (error.request) {
        logger.error('No response from wallet service:', error.message);
        throw new Error('Wallet service is not responding');
      } else {
        logger.error('Wallet balance check error:', error.message);
        throw new Error('Failed to check wallet balance');
      }
    }
  }

  async sendNotification({ userId, type, title, message, data = {}, includeSound = false }) {
    try {
      await axios.post(`${NOTIFICATION_SERVICE_URL}/notification/send`, {
        userId,
        type,
        title,
        message,
        channel: 'in_app',
        priority: 'high',
        data: {
          ...data,
          playSound: includeSound
        }
      }, { timeout: 5000 });
    } catch (error) {
      logger.error('Failed to send notification:', error);
    }
  }

  async logAudit({ eventType, userId, referenceId, referenceType, amount, provider, status, details }) {
    try {
      await prisma.paymentAuditLog.create({
        data: {
          eventType: eventType,
          userId: userId,
          referenceId: referenceId,
          referenceType: referenceType,
          amount,
          provider,
          status,
          details
        }
      });
    } catch (error) {
      logger.error('Failed to log audit:', error);
    }
  }

  async confirmDeposit({ referenceNumber, transactionMessage, userId }) {
    try {
      // Find the deposit
      const deposit = await prisma.deposit.findFirst({
        where: {
          referenceNumber: referenceNumber,
          userId: userId
        }
      });

      if (!deposit) {
        throw new Error('Deposit not found');
      }

      if (deposit.status !== 'pending_payment') {
        throw new Error(`Cannot confirm deposit with status: ${deposit.status}`);
      }

      const providerTid = TidParser.extractTid(transactionMessage);

      // Update deposit with transaction message and change status to pending approval
      await prisma.deposit.update({
        where: { depositId: deposit.depositId },
        data: {
          transactionMessage: transactionMessage,
          status: 'pending_approval',
          ...(providerTid ? { providerTid } : {})
        }
      });

      if (providerTid) {
        try {
          await MobileMoneyMessageService.storeMessage(transactionMessage, deposit.depositId);
        } catch (messageError) {
          logger.warn(
            { err: messageError, depositId: deposit.depositId, providerTid },
            'Failed to store mobile money message for deposit'
          );
        }
      }

      // Log audit
      await this.logAudit({
        eventType: 'deposit_confirmed',
        userId,
        referenceId: deposit.depositId,
        referenceType: 'deposit',
        amount: deposit.totalAmount,
        provider: deposit.provider,
        status: 'pending_approval',
        details: { referenceNumber, hasTransactionMessage: !!transactionMessage }
      });

      logger.info('Deposit confirmed, awaiting approval:', {
        depositId: deposit.depositId,
        referenceNumber
      });

      await this.notifyAdminsForApproval({
        title: 'Deposit approval required',
        message: `Deposit ${deposit.referenceNumber} for TZS ${Number(deposit.amount).toLocaleString()} needs approval.`,
        data: {
          depositId: deposit.depositId,
          referenceNumber: deposit.referenceNumber,
          amount: deposit.amount,
          actionUrl: '/admin/deposits'
        }
      });

      // Emit real-time update to admins
      await socketEmitter.emitCurrentPendingStats();

      // Send notification
      this.sendNotification({
        userId,
        type: 'payment',
        title: 'Deposit Submitted',
        message: `Your deposit of ${deposit.amount} TZS is awaiting admin approval`
      });

      return {
        success: true,
        depositId: deposit.depositId,
        referenceNumber,
        status: 'pending_approval',
        message: 'Deposit submitted successfully. Awaiting admin approval.'
      };
    } catch (error) {
      logger.error('Deposit confirmation failed:', error);
      throw error;
    }
  }

  async approveDeposit({ depositId, adminId, transactionMessage = null }) {
    try {
      // Find the deposit
      const deposit = await prisma.deposit.findUnique({
        where: { depositId: depositId }
      });

      if (!deposit) {
        throw new Error('Deposit not found');
      }

      if (deposit.status !== 'pending_approval') {
        throw new Error(`Cannot approve deposit with status: ${deposit.status}`);
      }

      // Credit user wallet with the deposit amount (not including fee)
      await this.creditWallet({
        walletId: deposit.walletId,
        userId: deposit.userId,
        depositId: deposit.depositId,
        amount: deposit.amount,
        referenceNumber: deposit.referenceNumber,
        description: `Deposit via ${deposit.provider}`
      });

      // Credit platform wallet with the fee
      if (deposit.fee && parseFloat(deposit.fee) > 0) {
        const platformWalletId = process.env.PLATFORM_WALLET_ID;
        if (platformWalletId) {
          await this.creditWallet({
            walletId: platformWalletId,
            userId: 'system',
            depositId: `FEE-${deposit.depositId}`,
            amount: deposit.fee,
            referenceNumber: `FEE-${deposit.referenceNumber}`,
            description: `Deposit fee from ${deposit.provider}`
          });
        } else {
          logger.warn('Platform wallet ID not configured, fee not credited');
        }
      }

      // Mark deposit completed after wallet credit event is emitted.
      await prisma.deposit.update({
        where: { depositId: depositId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          approvedBy: adminId,
          approvedAt: new Date(),
          transactionMessage: transactionMessage
        }
      });

      // Get updated wallet balance
      let newBalance = 0;
      try {
        const walletResponse = await axios.get(`${WALLET_SERVICE_URL}/${deposit.walletId}`, {
          timeout: 5000
        });
        newBalance = walletResponse.data?.data?.balance || 0;
      } catch (error) {
        logger.error('Failed to get wallet balance for notification:', error);
      }

      // Get admin info for agent name
      let adminName = 'ADMIN';
      let adminPhone = '+255000000000';
      try {
        const authResponse = await axios.get(`${process.env.AUTH_SERVICE_URL || 'http://localhost:3001'}/users/${adminId}`, {
          timeout: 5000
        });
        adminName = authResponse.data?.data?.fullName || authResponse.data?.data?.username || 'ADMIN';
        adminPhone = authResponse.data?.data?.phoneNumber || '+255000000000';
      } catch (error) {
        logger.warn('Failed to get admin info for notification:', error);
      }

      // Log audit
      await this.logAudit({
        eventType: 'deposit_approved',
        userId: deposit.userId,
        referenceId: depositId,
        referenceType: 'deposit',
        amount: deposit.totalAmount,
        provider: deposit.provider,
        status: 'completed',
        details: { adminId, amount: deposit.amount, fee: deposit.fee, transactionMessage }
      });

      logger.info('Deposit approved and wallets credited:', {
        depositId,
        userId: deposit.userId,
        amount: deposit.amount,
        fee: deposit.fee
      });

      // Format notification message
      const notificationMessage = formatTransactionNotification({
        referenceNumber: deposit.referenceNumber,
        transactionType: 'deposit',
        amount: parseFloat(deposit.amount),
        agentPhone: adminPhone,
        agentName: adminName,
        newBalance: parseFloat(newBalance),
        transactionCost: parseFloat(deposit.fee || 0),
        provider: deposit.provider.toUpperCase(),
        transactionMessage
      });

      // Send notification to user with sound
      this.sendNotification({
        userId: deposit.userId,
        type: 'payment',
        title: 'Deposit Confirmed',
        message: notificationMessage,
        data: {
          depositId,
          amount: deposit.amount,
          referenceNumber: deposit.referenceNumber,
          provider: deposit.provider
        },
        includeSound: true
      });

      await this.notifyFinanceManagers({
        title: 'Deposit Approved',
        message: `Deposit ${deposit.referenceNumber} for TZS ${Number(deposit.amount).toLocaleString()} approved.`,
        data: {
          userId: deposit.userId,
          depositId,
          referenceNumber: deposit.referenceNumber,
          amount: deposit.amount,
          provider: deposit.provider,
          status: 'completed',
          actionUrl: '/admin/deposits'
        }
      });

      return {
        success: true,
        depositId,
        amount: parseFloat(deposit.amount),
        fee: parseFloat(deposit.fee),
        status: 'completed'
      };
    } catch (error) {
      logger.error('Deposit approval failed:', error);
      throw error;
    }
  }
}

module.exports = new PaymentProcessingService();
