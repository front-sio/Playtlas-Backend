// Shared BullMQ queue names across all services.

const QueueNames = {
  // Notification fan-out queues
  NOTIFICATIONS_EMAIL: 'notifications-email',
  NOTIFICATIONS_SMS: 'notifications-sms',
  NOTIFICATIONS_IN_APP: 'notifications-in_app',
  NOTIFICATIONS_HIGH_THROUGHPUT: 'notifications-bulk',

  // Auth
  AUTH_OTP: 'auth-otp',

  // Wallet
  WALLET_OPERATIONS: 'wallet-operations',
  WALLET_PAYOUTS: 'wallet-payouts',

  // Tournament
  TOURNAMENT_MATCHMAKING: 'tournament-matchmaking',
  TOURNAMENT_STAGE_PROGRESSION: 'tournament-stage_progression',

  // Game
  GAME_SESSION_CLEANUP: 'game-session_cleanup'
};

module.exports = {
  QueueNames
};
