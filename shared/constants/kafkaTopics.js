// Shared Kafka topic names across all services.

const KafkaTopics = {
  PLAYER_REGISTERED: 'auth.player_registered',
  AGENT_REGISTERED: 'auth.agent_registered',

  WALLET_SEASON_FEE_PAID: 'wallet.season_fee_paid',
  WALLET_UPDATED: 'wallet.wallet_updated',

  TOURNAMENT_MATCH_GENERATED: 'tournament.match_generated',
  TOURNAMENT_STAGE_UPDATED: 'tournament.tournament_stage_updated',
  TOURNAMENT_PLAYER_ADVANCED: 'tournament.player_advanced_stage',
  TOURNAMENT_PRIZE_DISTRIBUTED: 'tournament.prize_distributed',
  SEASON_CANCELLED: 'tournament.season_cancelled',

  GAME_MATCH_COMPLETED: 'game.match_completed',

  NOTIFICATION_SEND: 'notification.send'
};

module.exports = {
  KafkaTopics
};  
