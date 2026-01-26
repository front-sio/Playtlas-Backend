const express = require('express');
const paymentController = require('../controllers/paymentController.js');
const floatAdjustmentController = require('../controllers/floatAdjustmentController.js');
const tournamentFeeController = require('../controllers/tournamentFeeController.js');
const transferController = require('../controllers/transferController.js');
const { authMiddleware } = require('../../../../shared/middlewares/authMiddleware.js');

const router = express.Router();

// Deposit endpoints
router.post('/deposit/initiate', authMiddleware, paymentController.initiateDeposit);
router.post('/deposit/confirm', authMiddleware, paymentController.confirmDeposit);
router.post('/deposit/:depositId/approve', authMiddleware, paymentController.approveDeposit);
router.post('/deposit/:depositId/reject', authMiddleware, paymentController.rejectDeposit);
router.get('/deposit/:referenceNumber', paymentController.getDepositStatus);
router.get('/admin/deposits/pending', authMiddleware, paymentController.listPendingDeposits);
router.get('/admin/deposits/by-tid', authMiddleware, paymentController.getDepositByTid);
router.post('/admin/deposits/approve-by-tid', authMiddleware, paymentController.approveDepositByTid);

// Withdrawal endpoints
router.post('/withdrawal/initiate', authMiddleware, paymentController.initiateWithdrawal);
router.get('/withdrawal/:referenceNumber', paymentController.getWithdrawalStatus);
router.post('/withdrawal/:withdrawalId/approve', authMiddleware, paymentController.approveWithdrawal);
router.post('/withdrawal/:withdrawalId/reject', authMiddleware, paymentController.rejectWithdrawal);
router.get('/admin/withdrawals/pending', authMiddleware, paymentController.listPendingWithdrawals);
router.get('/withdrawal/fee/calculate', paymentController.calculateWithdrawalFee);

// Payment methods
router.post('/methods', authMiddleware, paymentController.addPaymentMethod);
router.get('/methods', authMiddleware, paymentController.getPaymentMethods);
router.delete('/methods/:methodId', authMiddleware, paymentController.deletePaymentMethod);

// Payment providers info (public - no auth required)
router.get('/providers/all', paymentController.getAllProviders);
router.get('/providers/:code', paymentController.getProviderInfo);

// Transaction history
router.get('/transactions', authMiddleware, paymentController.getTransactionHistory);
router.get('/admin/transactions', authMiddleware, paymentController.listAdminTransactions);
router.get('/admin/stats', authMiddleware, paymentController.getAdminStats);

// Tournament fee endpoints
router.post('/tournament-fee', authMiddleware, tournamentFeeController.payTournamentFee);
router.get('/tournament-fees', authMiddleware, tournamentFeeController.getTournamentFees);
router.post('/tournament-fees/:feeId/refund', authMiddleware, tournamentFeeController.refundTournamentFee);

// Wallet transfer endpoints
router.post('/transfer', authMiddleware, transferController.transferFunds);
router.post('/internal-transfer', authMiddleware, transferController.internalTransfer);
router.get('/transfers', authMiddleware, transferController.getTransfers);
router.get('/transfers/:transferId', authMiddleware, transferController.getTransfer);

// Callbacks/Webhooks (public endpoints)
router.post('/callback/:provider', paymentController.handleCallback);

// Float adjustment endpoints (admin only)
router.post('/float-adjustment/request', authMiddleware, floatAdjustmentController.requestFloatAdjustment);
router.get('/float-adjustment/requests', authMiddleware, floatAdjustmentController.getFloatAdjustmentRequests);
router.get('/float-adjustment/requests/:requestId', authMiddleware, floatAdjustmentController.getFloatAdjustmentById);
router.post('/float-adjustment/:requestId/approve', authMiddleware, floatAdjustmentController.approveFloatAdjustment);
router.post('/float-adjustment/:requestId/reject', authMiddleware, floatAdjustmentController.rejectFloatAdjustment);

// TID-based topup approval endpoints
router.post('/admin/sms-messages', authMiddleware, paymentController.storeSmsMessage);
router.get('/admin/sms-messages/search', authMiddleware, paymentController.searchByTid);
router.get('/admin/sms-messages', authMiddleware, paymentController.listSmsMessages);
router.get('/admin/sms-messages/stats', authMiddleware, paymentController.getSmsMessageStats);
router.post('/admin/deposits/:depositId/attach-message', authMiddleware, paymentController.attachMessageToDeposit);
router.post('/admin/deposits/:depositId/approve-with-tid', authMiddleware, paymentController.approveDepositWithTid);

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'payment-service' });
});

module.exports = router;
