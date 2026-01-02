// Payment provider configurations
// This centralizes payment provider information for security and consistency

const providers = {
  airtel: {
    name: 'Airtel Money',
    code: 'airtel',
    lipaNumber: process.env.AIRTEL_LIPA_NUMBER || '1234567',
    instructions: `
Airtel Money (USSD)
1. Piga *150*60# kwenye simu yako
2. Chagua 5 (Pay by Phone) kisha 1 (All Networks)
3. Chagua 1 kuweka Airtel Pay Number
4. Weka kiasi: {amount} TSH na namba ya Airtel Pay: {lipanumber}
5. Thibitisha kwa PIN yako kisha subiri ujumbe wa mafanikio

My Airtel App
1. Fungua My Airtel App
2. Chagua Scan & Pay au Pay by Phone
3. Ingiza Airtel Pay/Till Number: {lipanumber}
4. Weka kiasi cha kulipa: {amount} TSH na thibitisha kwa PIN yako
5. Rudia hapa na bonyeza "Payment Sent - Confirm"
    `,
    enabled: true,
    minAmount: 1000,
    maxAmount: 5000000,
    fee: 0, // Withdrawal fee
    depositFeePercentage: parseFloat(process.env.DEPOSIT_FEE_PERCENTAGE || '1') / 100, // 1% deposit fee
  },
  mpesa: {
    name: 'M-Pesa',
    code: 'mpesa',
    lipaNumber: process.env.MPESA_SHORTCODE || '123456',
    instructions: `
1. Open M-Pesa on your phone
2. Select "Lipa na M-Pesa Online"
3. Enter business code: {lipanumber}
4. Enter amount: {amount} TSH
5. Confirm with your M-Pesa PIN
6. Return here and click "Payment Sent - Confirm"
    `,
    enabled: true,
    minAmount: 1000,
    maxAmount: 5000000,
    fee: 0,
    depositFeePercentage: parseFloat(process.env.DEPOSIT_FEE_PERCENTAGE || '1') / 100,
  },
  tigo: {
    name: 'Mixx by Yas',
    code: 'yas',
    lipaNumber: process.env.TIGO_LIPA_NUMBER || process.env.TIGO_PESA_LIPA || '000000',
    instructions: `
1. Open Mixx by Yas app or dial *150#
2. Select "Payment" option
3. Enter the business account: {lipanumber}
4. Enter amount: {amount} TSH
5. Confirm the transaction
6. Return here and click "Payment Sent - Confirm"
    `,
    enabled: true,
    minAmount: 1000,
    maxAmount: 5000000,
    fee: 0,
    depositFeePercentage: parseFloat(process.env.DEPOSIT_FEE_PERCENTAGE || '1') / 100,
  },
  halopesa: {
    name: 'HaloPesa',
    code: 'halopesa',
    lipaNumber: process.env.HALOPESA_LIPA_NUMBER || '000000',
    instructions: `
1. Open HaloPesa app
2. Select "Transfer" or "Pay"
3. Enter HaloPesa number: {lipanumber}
4. Enter amount: {amount} TSH
5. Confirm transaction
6. Return here and click "Payment Sent - Confirm"
    `,
    enabled: true,
    minAmount: 1000,
    maxAmount: 5000000,
    fee: 0,
    depositFeePercentage: parseFloat(process.env.DEPOSIT_FEE_PERCENTAGE || '1') / 100,
  },
};

function getProvider(code) {
  if (!code) return null;
  return providers[code.toLowerCase()];
}

function getEnabledProviders() {
  return Object.values(providers).filter(p => p.enabled);
}

function getProviderInstructions(code, amount) {
  const provider = getProvider(code);
  if (!provider) return null;

  const lipaNumber = provider.lipaNumber || 'N/A';
  const amountValue = amount !== undefined && amount !== null ? amount : '{amount}';

  return provider.instructions
    .replace(/{lipanumber}/gi, lipaNumber)
    .replace(/{amount}/gi, amountValue)
    .trim();
}

function calculateDepositDetails(code, amountInput) {
  const provider = getProvider(code);
  const amount = typeof amountInput === 'number' ? amountInput : parseFloat(amountInput);

  if (!provider || Number.isNaN(amount) || amount <= 0) {
    return null;
  }

  const percentage = provider.depositFeePercentage || 0;
  const feeAmount = parseFloat((amount * percentage).toFixed(2));
  const totalPayable = parseFloat((amount + feeAmount).toFixed(2));

  return {
    requestedAmount: parseFloat(amount.toFixed(2)),
    feeAmount,
    totalPayable,
    depositFeePercentage: percentage,
  };
}

module.exports = {
  providers,
  getProvider,
  getEnabledProviders,
  getProviderInstructions,
  calculateDepositDetails,
};
