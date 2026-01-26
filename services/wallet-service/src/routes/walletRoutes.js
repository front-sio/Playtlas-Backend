const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const authMiddleware = require('../middlewares/authMiddleware');
const serviceAuth = require('../middlewares/serviceAuth');

// Wallet management
router.post('/create', serviceAuth, walletController.createWallet);
router.get('/balance', authMiddleware, walletController.getUserBalance);
router.get('/transactions', authMiddleware, walletController.getUserTransactions);
router.get('/owner/:ownerId', serviceAuth, walletController.getWalletByOwner);
router.get('/:walletId', serviceAuth, walletController.getWallet);
router.get('/:walletId/balance', serviceAuth, walletController.getBalance);

// Internal operations (used by Kafka consumers or system operations)
router.post('/credit', serviceAuth, walletController.creditWallet);
router.post('/debit', serviceAuth, walletController.debitWallet);
router.post('/transfer', serviceAuth, walletController.transferFunds);
router.get('/transfer/lookup/phone/:phoneNumber', authMiddleware, walletController.lookupRecipientByPhone);
router.post('/transfer/phone', authMiddleware, walletController.transferFundsByPhone);
router.post('/pay-tournament-fee', serviceAuth, walletController.payTournamentFee);
router.get('/:walletId/transactions', serviceAuth, walletController.getTransactions);

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
router.get('/system/wallet', serviceAuth, walletController.getSystemWallet);
router.get('/platform/wallet', serviceAuth, walletController.getPlatformWallet);
router.get('/stats', authMiddleware, walletController.getWalletStats);
router.get('/report', authMiddleware, walletController.getWalletReport);
router.get('/admin/wallets', authMiddleware, walletController.listWallets);
router.put('/admin/wallets/:walletId', authMiddleware, walletController.updateWallet);

// Admin endpoints
router.get('/admin/transactions', authMiddleware, walletController.getAllTransactions);

module.exports = router;
