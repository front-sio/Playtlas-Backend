const { v4: uuidv4 } = require('uuid');
const { subscribeEvents, publishEvent, Topics } = require('../../../../shared/events');
const logger = require('../utils/logger');

const pending = new Map();
let consumerStarted = false;

function startTournamentCommandResponseConsumer() {
  if (consumerStarted) return;
  consumerStarted = true;

  subscribeEvents('admin-service-tournament-command-results', [Topics.TOURNAMENT_COMMAND_RESULT], async (topic, payload) => {
    if (topic !== Topics.TOURNAMENT_COMMAND_RESULT) return;
    const { commandId, status, data, error } = payload || {};
    if (!commandId) return;

    const entry = pending.get(commandId);
    if (!entry) return;

    pending.delete(commandId);
    if (entry.timeout) clearTimeout(entry.timeout);

    if (status === 'success') {
      entry.resolve({ success: true, data });
    } else {
      entry.reject(new Error(error || 'Tournament command failed'));
    }
  }).catch((err) => {
    logger.error({ err }, '[tournament-command-client] Failed to start response consumer');
    consumerStarted = false;
  });
}

async function sendTournamentCommand({ action, data, actor, timeoutMs = 8000 }) {
  const commandId = uuidv4();
  const payload = { commandId, action, data: data || {}, actor: actor || null };

  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(commandId);
      reject(new Error('Tournament command timed out'));
    }, timeoutMs);
    pending.set(commandId, { resolve, reject, timeout });
  });

  await publishEvent(Topics.TOURNAMENT_COMMAND, payload, commandId);
  return promise;
}

module.exports = {
  startTournamentCommandResponseConsumer,
  sendTournamentCommand
};
