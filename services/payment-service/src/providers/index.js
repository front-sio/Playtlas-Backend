const { providers: providerConfigs } = require('../config/providers.js');

const AUTO_COMPLETE =
  String(process.env.PAYMENT_PROVIDER_AUTO_COMPLETE || '').toLowerCase() === 'true';

const normalizeStatus = (rawStatus) => {
  if (!rawStatus) return 'pending';
  const status = String(rawStatus).toLowerCase();

  if (['success', 'completed', 'complete', 'paid', 'successful', 'ok'].includes(status)) {
    return 'completed';
  }

  if (['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled'].includes(status)) {
    return 'failed';
  }

  return 'pending';
};

const parseCallbackPayload = (payload = {}) => {
  const referenceNumber =
    payload.referenceNumber ||
    payload.reference ||
    payload.reference_no ||
    payload.referenceNumber ||
    payload.ref ||
    payload.requestId ||
    payload.transactionRef ||
    payload.externalReference ||
    payload.external_reference;

  const transactionId =
    payload.transactionId ||
    payload.transaction_id ||
    payload.transId ||
    payload.trans_id ||
    payload.receiptNumber ||
    payload.receipt_number ||
    payload.externalReference ||
    payload.external_reference;

  const amount =
    payload.amount ||
    payload.amountPaid ||
    payload.total ||
    payload.totalPaid ||
    payload.total_paid;

  const status = normalizeStatus(payload.status || payload.result || payload.state || payload.outcome);

  return {
    referenceNumber,
    transactionId,
    amount: typeof amount === 'number' ? amount : amount ? parseFloat(amount) : undefined,
    status,
    responseDesc: payload.responseDesc || payload.message || payload.reason || null,
  };
};

const createProvider = (code) => {
  const config = providerConfigs[code];
  if (!config) return null;

  const baseTransactionId = (prefix, referenceNumber) =>
    `${code.toUpperCase()}-${prefix}-${referenceNumber}`;

  return {
    code,
    name: config.name,
    initiateDeposit: async ({ phoneNumber, amount, referenceNumber }) => ({
      success: true,
      provider: code,
      transactionId: baseTransactionId('DEP', referenceNumber),
      referenceNumber,
      amount,
      phoneNumber,
    }),
    initiateWithdrawal: async ({ phoneNumber, amount, referenceNumber }) => ({
      success: true,
      provider: code,
      transactionId: baseTransactionId('WDR', referenceNumber),
      referenceNumber,
      amount,
      phoneNumber,
    }),
    parseCallback: (payload) => {
      const parsed = parseCallbackPayload(payload);
      return {
        ...parsed,
        status: parsed.status || 'pending',
      };
    },
    queryTransaction: async (externalReference) => ({
      success: true,
      status: AUTO_COMPLETE ? 'completed' : 'pending',
      transactionId: externalReference,
    }),
  };
};

const providerRegistry = Object.keys(providerConfigs).reduce((acc, code) => {
  const provider = createProvider(code);
  if (provider) {
    acc[code] = provider;
  }
  return acc;
}, {});

const getProvider = (code) => {
  if (!code) {
    throw new Error('Payment provider code is required');
  }

  const provider = providerRegistry[code.toLowerCase()];
  if (!provider) {
    throw new Error(`Unsupported payment provider: ${code}`);
  }

  return provider;
};

module.exports = {
  getProvider,
  providerRegistry,
};
