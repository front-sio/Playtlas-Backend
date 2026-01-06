-- CreateTable
CREATE TABLE "tournament_fees" (
    "feeId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "seasonId" UUID NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "referenceNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "failureReason" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_fees_pkey" PRIMARY KEY ("feeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "tournament_fees_referenceNumber_key" ON "tournament_fees"("referenceNumber");
