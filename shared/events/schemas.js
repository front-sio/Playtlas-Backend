// Runtime schemas / validators for core Kafka events.
// No external validation library is used to keep things lightweight.
// Each validator returns { ok: boolean, value?: any, error?: string }.

function isString(val) {
  return typeof val === 'string' && val.length > 0;
}

function validatePlayerRegistered(payload) {
  if (!payload || !isString(payload.userId)) return { ok: false, error: 'userId is required' };
  if (!isString(payload.username)) return { ok: false, error: 'username is required' };
  if (!isString(payload.email)) return { ok: false, error: 'email is required' };
  if (!isString(payload.phoneNumber)) return { ok: false, error: 'phoneNumber is required' };
  return { ok: true, value: payload };
}

function validateWalletCreated(payload) {
  if (!payload || !isString(payload.walletId)) return { ok: false, error: 'walletId is required' };
  if (!isString(payload.ownerId)) return { ok: false, error: 'ownerId is required' };
  if (!isString(payload.type)) return { ok: false, error: 'type is required' };
  if (!isString(payload.currency)) return { ok: false, error: 'currency is required' };
  return { ok: true, value: payload };
}

function validatePlayerJoinedSeason(payload) {
  if (!payload || !isString(payload.tournamentId)) return { ok: false, error: 'tournamentId is required' };
  if (!isString(payload.seasonId)) return { ok: false, error: 'seasonId is required' };
  if (!isString(payload.playerId)) return { ok: false, error: 'playerId is required' };
  return { ok: true, value: payload };
}

function validateSeasonCompleted(payload) {
  if (!payload || !isString(payload.tournamentId)) return { ok: false, error: 'tournamentId is required' };
  if (!isString(payload.seasonId)) return { ok: false, error: 'seasonId is required' };
  if (!isString(payload.status)) return { ok: false, error: 'status is required' };
  return { ok: true, value: payload };
}

function validateMatchCompleted(payload) {
  if (!payload || !isString(payload.tournamentId)) return { ok: false, error: 'tournamentId is required' };
  if (!isString(payload.seasonId)) return { ok: false, error: 'seasonId is required' };
  if (!isString(payload.matchId)) return { ok: false, error: 'matchId is required' };
  if (!isString(payload.stage)) return { ok: false, error: 'stage is required' };
  if (typeof payload.roundNumber !== 'number') return { ok: false, error: 'roundNumber must be a number' };
  if (!isString(payload.winnerId)) return { ok: false, error: 'winnerId is required' };
  if (!isString(payload.loserId)) return { ok: false, error: 'loserId is required' };
  return { ok: true, value: payload };
}

function validateMatchResult(payload) {
  if (!payload || !isString(payload.matchId)) return { ok: false, error: 'matchId is required' };
  if (!isString(payload.winnerId)) return { ok: false, error: 'winnerId is required' };
  return { ok: true, value: payload };
}

function validatePrizeCredited(payload) {
  if (!payload || !isString(payload.tournamentId)) return { ok: false, error: 'tournamentId is required' };
  if (!isString(payload.seasonId)) return { ok: false, error: 'seasonId is required' };
  if (!isString(payload.winnerId)) return { ok: false, error: 'winnerId is required' };
  if (!isString(payload.walletId)) return { ok: false, error: 'walletId is required' };
  if (!isString(payload.amount)) return { ok: false, error: 'amount is required' };
  if (!isString(payload.currency)) return { ok: false, error: 'currency is required' };
  return { ok: true, value: payload };
}

function validateDepositApproved(payload) {
  if (!payload || !isString(payload.depositId)) return { ok: false, error: 'depositId is required' };
  if (!isString(payload.walletId)) return { ok: false, error: 'walletId is required' };
  if (!isString(payload.userId)) return { ok: false, error: 'userId is required' };
  if (typeof payload.amount !== 'number' && typeof payload.amount !== 'string') return { ok: false, error: 'amount is required' };
  if (!isString(payload.referenceNumber)) return { ok: false, error: 'referenceNumber is required' };
  return { ok: true, value: payload };
}

function validateWithdrawalApproved(payload) {
  if (!payload || !isString(payload.withdrawalId)) return { ok: false, error: 'withdrawalId is required' };
  if (!isString(payload.walletId)) return { ok: false, error: 'walletId is required' };
  if (!isString(payload.userId)) return { ok: false, error: 'userId is required' };
  if (typeof payload.amount !== 'number' && typeof payload.amount !== 'string') return { ok: false, error: 'amount is required' };
  if (!isString(payload.referenceNumber)) return { ok: false, error: 'referenceNumber is required' };
  return { ok: true, value: payload };
}

function validateNotificationSend(payload) {
  if (!payload) return { ok: false, error: 'payload is required' };
  if (!isString(payload.userId)) return { ok: false, error: 'userId is required' };
  if (!isString(payload.channel)) return { ok: false, error: 'channel is required' };
  if (!isString(payload.type)) return { ok: false, error: 'type is required' };
  if (!isString(payload.title)) return { ok: false, error: 'title is required' };
  if (!isString(payload.message)) return { ok: false, error: 'message is required' };
  return { ok: true, value: payload };
}

function validateTournamentCommand(payload) {
  if (!payload) return { ok: false, error: 'payload is required' };
  if (!isString(payload.commandId)) return { ok: false, error: 'commandId is required' };
  if (!isString(payload.action)) return { ok: false, error: 'action is required' };
  if (!payload.data || typeof payload.data !== 'object') return { ok: false, error: 'data is required' };
  // Optional actor metadata for auditing.
  if (payload.actor && typeof payload.actor !== 'object') return { ok: false, error: 'actor must be an object' };
  return { ok: true, value: payload };
}

function validateTournamentCommandResult(payload) {
  if (!payload) return { ok: false, error: 'payload is required' };
  if (!isString(payload.commandId)) return { ok: false, error: 'commandId is required' };
  if (!isString(payload.action)) return { ok: false, error: 'action is required' };
  if (!isString(payload.status)) return { ok: false, error: 'status is required' };
  return { ok: true, value: payload };
}

function validateTournamentLifecycle(payload) {
  if (!payload) return { ok: false, error: 'payload is required' };
  if (!isString(payload.tournamentId)) return { ok: false, error: 'tournamentId is required' };
  if (!isString(payload.name)) return { ok: false, error: 'name is required' };
  if (!isString(payload.status)) return { ok: false, error: 'status is required' };
  return { ok: true, value: payload };
}

const validatorsByTopic = {
  'auth.player_registered': validatePlayerRegistered,
  'wallet.wallet_created': validateWalletCreated,
  'tournament.player_joined_season': validatePlayerJoinedSeason,
  'tournament.season_completed': validateSeasonCompleted,
  'tournament.match_completed': validateMatchCompleted,
  'tournament.match_result': validateMatchResult,
  'wallet.prize_credited': validatePrizeCredited,
  'notification.send': validateNotificationSend,

  'payment.deposit_approved': validateDepositApproved,
  'payment.withdrawal_approved': validateWithdrawalApproved,

  'tournament.command': validateTournamentCommand,
  'tournament.command_result': validateTournamentCommandResult,
  'tournament.created': validateTournamentLifecycle,
  'tournament.started': validateTournamentLifecycle,
  'tournament.stopped': validateTournamentLifecycle,
  'tournament.cancelled': validateTournamentLifecycle,
  'tournament.updated': validateTournamentLifecycle,
  'tournament.deleted': validateTournamentLifecycle
};

function validateEventPayload(topic, payload) {
  const validator = validatorsByTopic[topic];
  if (!validator) return { ok: true, value: payload };
  return validator(payload);
}

module.exports = {
  validateEventPayload
};
