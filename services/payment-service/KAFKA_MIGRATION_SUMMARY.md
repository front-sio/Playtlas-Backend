# Kafka Event-Driven Wallet Credit/Debit Implementation

## Summary
Migrated from direct HTTP calls to Kafka event-driven architecture for wallet credit/debit operations.

## Changes Made

### 1. Shared Events (backend/shared/events/)
- **index.js**: Added new topics `DEPOSIT_APPROVED` and `WITHDRAWAL_APPROVED`
- **schemas.js**: Added validators for `validateDepositApproved` and `validateWithdrawalApproved`

### 2. Payment Service (backend/services/payment-service/)
- **src/services/paymentProcessing.js**:
  - `creditWallet()`: Changed from HTTP POST to publishing `DEPOSIT_APPROVED` Kafka event
  - `debitWallet()`: Changed from HTTP POST to publishing `WITHDRAWAL_APPROVED` Kafka event
  - Updated all call sites to pass required parameters: `userId`, `depositId`/`withdrawalId`

### 3. Wallet Service (backend/services/wallet-service/)
- **prisma/schema.prisma**: 
  - ❌ Removed `Transaction` model (transactions now in payment-service)
  - ✅ Kept `Wallet`, `DepositRequest`, and `Payout` models
  
- **src/kafka/walletConsumers.js**:
  - Added `handleDepositApproved()`: Listens to `DEPOSIT_APPROVED`, increments wallet balance
  - Added `handleWithdrawalApproved()`: Listens to `WITHDRAWAL_APPROVED`, decrements wallet balance
  - Updated `startWalletConsumers()` to subscribe to new events

- **src/controllers/walletController.js**:
  - `creditWallet()`: Simplified to direct balance update (no transaction record)
  - `debitWallet()`: Simplified to direct balance update (no transaction record)
  - `getTransactions()`: Returns 410 with message to use payment service
  - `getUserTransactions()`: Returns 410 with message to use payment service
  - `getAllTransactions()`: Returns 410 with message to use payment service
  - `getWalletStats()`: Removed transaction count/breakdown
  - `getWalletReport()`: Removed transaction aggregations

## Event Flow

### Deposit Approval
```
Admin approves deposit
    ↓
Payment Service publishes DEPOSIT_APPROVED event
    ↓
Wallet Service consumes event
    ↓
Wallet balance incremented
    ↓
Notification sent to user
```

### Withdrawal Processing
```
Withdrawal initiated
    ↓
Payment Service publishes WITHDRAWAL_APPROVED event
    ↓
Wallet Service consumes event
    ↓
Wallet balance decremented
    ↓
Notification sent to user
```

## Event Payloads

### DEPOSIT_APPROVED
```json
{
  "depositId": "uuid",
  "walletId": "uuid",
  "userId": "uuid",
  "amount": 10000,
  "referenceNumber": "DEP-123456",
  "description": "Deposit via Vodacom M-Pesa"
}
```

### WITHDRAWAL_APPROVED
```json
{
  "withdrawalId": "uuid",
  "walletId": "uuid",
  "userId": "uuid",
  "amount": 5000,
  "referenceNumber": "WDR-789012",
  "description": "Withdrawal via Airtel Money"
}
```

## Benefits
1. ✅ **Decoupling**: Payment and wallet services are fully decoupled
2. ✅ **Reliability**: Kafka ensures event delivery and retry
3. ✅ **Single Source of Truth**: Transactions stored only in payment-service
4. ✅ **Scalability**: Easy to add more consumers/services
5. ✅ **Audit Trail**: All payment events logged in Kafka

## Migration Notes
- Transaction history now exclusively in payment-service
- Use `/api/payment/transactions` instead of `/api/wallet/transactions`
- Wallet service focuses on balance management only
- Payment service handles all transaction history and reporting

## Next Steps
1. Run Prisma migration to drop Transaction table: `npx prisma migrate dev`
2. Restart wallet-service to apply changes
3. Restart payment-service to apply Kafka publisher
4. Test deposit approval flow
5. Test withdrawal processing flow
