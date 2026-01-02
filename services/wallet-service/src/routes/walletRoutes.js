const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authMiddleware = require('../middlewares/authMiddleware');

// Wallet management
router.post('/create', walletController.createWallet);
router.get('/balance', authMiddleware, walletController.getUserBalance);
router.get('/transactions', authMiddleware, walletController.getUserTransactions);
router.get('/owner/:ownerId', walletController.getWalletByOwner);
router.get('/:walletId', walletController.getWallet);
router.get('/:walletId/balance', walletController.getBalance);

// Internal operations (used by Kafka consumers or system operations)
router.post('/credit', walletController.creditWallet);
router.post('/debit', walletController.debitWallet);
router.post('/transfer', walletController.transferFunds);
router.get('/transfer/lookup/phone/:phoneNumber', authMiddleware, walletController.lookupRecipientByPhone);
router.post('/transfer/phone', authMiddleware, walletController.transferFundsByPhone);
router.post('/pay-tournament-fee', walletController.payTournamentFee);
router.get('/:walletId/transactions', walletController.getTransactions);

// Deprecated deposit request endpoints (moved to payment-service)
// These return 410 Gone status with redirect instructions
router.post('/deposit-request', authMiddleware, walletController.requestDeposit);
router.get('/deposit-requests', authMiddleware, walletController.getDepositRequests);
router.post('/deposit-requests/:requestId/approve', authMiddleware, walletController.approveDeposit);
router.post('/deposit-requests/:requestId/reject', authMiddleware, walletController.rejectDeposit);

// Payout/Withdrawal endpoints
router.post('/payout/request', authMiddleware, walletController.requestPayout);
router.get('/payout/requests', authMiddleware, walletController.getPayoutRequests);
router.post('/payout/requests/:payoutId/approve', authMiddleware, walletController.approvePayout);
router.post('/payout/requests/:payoutId/reject', authMiddleware, walletController.rejectPayout);

// System wallet
router.get('/system/wallet', walletController.getSystemWallet);
router.get('/platform/wallet', walletController.getPlatformWallet);
router.get('/stats', authMiddleware, walletController.getWalletStats);
router.get('/report', authMiddleware, walletController.getWalletReport);
router.get('/admin/wallets', authMiddleware, walletController.listWallets);
router.put('/admin/wallets/:walletId', authMiddleware, walletController.updateWallet);

// Admin endpoints
router.get('/admin/transactions', authMiddleware, walletController.getAllTransactions);

module.exports = router;
