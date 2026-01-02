// Shared domain statuses.

const TournamentStages = {
  PRELIMINARY: 'preliminary',
  ELIMINATION: 'elimination',
  GROUP: 'group',
  QUARTERFINAL: 'quarterfinal',
  SEMIFINAL: 'semifinal',
  FINAL: 'final'
};

const MatchStatus = {
  SCHEDULED: 'scheduled',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
};

const NotificationStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  READ: 'read'
};

const FundRequestStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled'
};

module.exports = {
  TournamentStages,
  MatchStatus,
  NotificationStatus,
  FundRequestStatus
};