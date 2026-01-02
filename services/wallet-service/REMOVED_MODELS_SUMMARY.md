# Removed DepositRequest and Payout Models from Wallet Service

## Summary
Removed DepositRequest and Payout models from wallet-service as all deposit/withdrawal operations are now handled by payment-service.

## Changes Made

### 1. Schema Changes (prisma/schema.prisma)
- ❌ Removed `DepositRequest` model
- ❌ Removed `Payout` model  
- ❌ Removed `Transaction` model (already removed earlier)
- ✅ Kept only `Wallet` model - simplified schema

**New Schema:**
```prisma
model Wallet {
  walletId    String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  ownerId     String   @db.Uuid
  type        String
  balance     Decimal  @db.Decimal(15, 2) @default("0")
  currency    String   @default("TZS")
  isActive    Boolean  @default(true)
  metadata    Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@map("wallets")
}
```

### 2. Controller Changes (src/controllers/walletController.js)
**Removed/Updated Functions:**
- `requestDeposit()` - Returns 410 Gone, redirects to payment-service
- `getDepositRequests()` - Returns 410 Gone, redirects to payment-service
- `approveDeposit()` - Returns 410 Gone, redirects to payment-service
- `rejectDeposit()` - Returns 410 Gone, redirects to payment-service
- `transferFunds()` - Removed transaction logging, keeps only balance updates
- `payTournamentFee()` - Removed transaction logging, keeps only balance updates

### 3. Kafka Consumer Changes (src/kafka/walletConsumers.js)
- ❌ Removed `getPayoutQueue()` function
- ❌ Removed payout queue creation
- ✅ Updated `handleTournamentMatchCompleted()` to directly credit wallet instead of queuing payout job
- ✅ Added prize credited event publishing
- ✅ Added winner notification

### 4. Server Changes (src/server.js)
- ❌ Removed `startPayoutWorker()` import
- ❌ Removed payout worker startup

### 5. Route Changes (src/routes/walletRoutes.js)
- Updated comments to indicate deposit endpoints are deprecated
- Routes still exist but return 410 Gone status with migration instructions

## Migration Instructions

### For API Clients
**Old Endpoints → New Endpoints:**
- `POST /api/wallet/deposit-request` → `POST /api/payment/deposit/initiate`
- `GET /api/wallet/deposit-requests` → `GET /api/payment/admin/deposits/pending`
- `POST /api/wallet/deposit-requests/:id/approve` → `POST /api/payment/deposit/:depositId/approve`
- `POST /api/wallet/deposit-requests/:id/reject` → `POST /api/payment/deposit/:depositId/reject`
- `GET /api/wallet/transactions` → `GET /api/payment/transactions`
- `GET /api/wallet/admin/transactions` → `GET /api/payment/admin/transactions`

### Database Migration
```bash
cd backend/services/wallet-service
npx prisma migrate dev --name remove_deposit_payout_transaction_models
npx prisma generate
```

## Benefits
1. ✅ **Single Responsibility**: Wallet service only manages balances
2. ✅ **Simplified Schema**: Only 1 model instead of 4
3. ✅ **No Duplicate Data**: Transactions stored once in payment-service
4. ✅ **Event-Driven**: Kafka handles all cross-service communication
5. ✅ **Better Separation**: Payment logic separate from wallet logic

## Wallet Service Responsibilities (Current)
- ✅ Create wallets for new users
- ✅ Maintain wallet balances
- ✅ Credit/debit via Kafka events
- ✅ Handle tournament prize distribution
- ✅ Process tournament fee payments
- ✅ Handle wallet-to-wallet transfers

## Payment Service Responsibilities
- ✅ Handle deposit requests
- ✅ Handle withdrawal requests
- ✅ Store all transaction history
- ✅ Integrate with payment providers (M-Pesa, Tigo, Airtel, etc.)
- ✅ Publish Kafka events for wallet updates
- ✅ Manage payment approvals/rejections

## Files Modified
- `prisma/schema.prisma`
- `src/controllers/walletController.js`
- `src/kafka/walletConsumers.js`
- `src/server.js`
- `src/routes/walletRoutes.js`

## Next Steps
1. ✅ Code changes complete
2. ⏳ Run Prisma migration to update database
3. ⏳ Restart wallet-service
4. ⏳ Update API documentation
5. ⏳ Notify frontend team of endpoint changes
