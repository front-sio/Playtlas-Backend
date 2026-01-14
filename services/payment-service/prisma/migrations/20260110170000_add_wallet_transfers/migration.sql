CREATE TABLE "wallet_transfers" (
  "transferId" UUID NOT NULL DEFAULT gen_random_uuid(),
  "fromUserId" UUID,
  "fromWalletId" UUID,
  "toUserId" UUID,
  "toWalletId" UUID,
  "amount" DECIMAL(15,2) NOT NULL,
  "fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'TZS',
  "description" TEXT,
  "referenceNumber" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "failureReason" TEXT,
  "processedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_transfers_pkey" PRIMARY KEY ("transferId")
);

CREATE UNIQUE INDEX "wallet_transfers_referenceNumber_key" ON "wallet_transfers"("referenceNumber");
CREATE INDEX "wallet_transfers_fromUserId_idx" ON "wallet_transfers"("fromUserId");
CREATE INDEX "wallet_transfers_toUserId_idx" ON "wallet_transfers"("toUserId");
CREATE INDEX "wallet_transfers_createdAt_idx" ON "wallet_transfers"("createdAt");
