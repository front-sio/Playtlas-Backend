-- CreateEnum
CREATE TYPE "FloatRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "deposits" (
    "depositId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "fee" DECIMAL(12,2),
    "totalAmount" DECIMAL(12,2),
    "phoneNumber" VARCHAR(32),
    "referenceNumber" VARCHAR(100) NOT NULL,
    "externalReference" VARCHAR(200),
    "transactionMessage" TEXT,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "callbackData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("depositId")
);

-- CreateTable
CREATE TABLE "payment_callbacks" (
    "callbackId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" VARCHAR(64) NOT NULL,
    "referenceNumber" VARCHAR(100),
    "callbackType" VARCHAR(32) NOT NULL,
    "payload" JSONB,
    "signature" VARCHAR(1024),
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_callbacks_pkey" PRIMARY KEY ("callbackId")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "withdrawalId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "methodId" UUID,
    "provider" VARCHAR(64),
    "amount" DECIMAL(12,2) NOT NULL,
    "fee" DECIMAL(12,2),
    "totalDeducted" DECIMAL(12,2),
    "phoneNumber" VARCHAR(32),
    "referenceNumber" VARCHAR(100) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "externalReference" VARCHAR(200),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "failureReason" TEXT,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("withdrawalId")
);

-- CreateTable
CREATE TABLE "payment_audit_log" (
    "auditId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventType" VARCHAR(128) NOT NULL,
    "userId" UUID,
    "referenceId" UUID,
    "referenceType" VARCHAR(64),
    "amount" DECIMAL(12,2),
    "provider" VARCHAR(64),
    "status" VARCHAR(64),
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_audit_log_pkey" PRIMARY KEY ("auditId")
);

-- CreateTable
CREATE TABLE "float_adjustment_requests" (
    "requestId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "walletId" UUID NOT NULL,
    "requestedBy" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "FloatRequestStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "float_adjustment_requests_pkey" PRIMARY KEY ("requestId")
);

-- CreateTable
CREATE TABLE "float_approvals" (
    "approvalId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requestId" UUID NOT NULL,
    "approvedBy" UUID NOT NULL,
    "approverRole" VARCHAR(50) NOT NULL,
    "comments" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "float_approvals_pkey" PRIMARY KEY ("approvalId")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "methodId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "phoneNumber" VARCHAR(32) NOT NULL,
    "accountName" VARCHAR(200),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("methodId")
);

-- CreateTable
CREATE TABLE "daily_limits" (
    "limitId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalDeposits" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "totalWithdrawals" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "depositCount" INTEGER NOT NULL DEFAULT 0,
    "withdrawalCount" INTEGER NOT NULL DEFAULT 0,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_limits_pkey" PRIMARY KEY ("limitId")
);

-- CreateIndex
CREATE UNIQUE INDEX "deposits_referenceNumber_key" ON "deposits"("referenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_referenceNumber_key" ON "withdrawals"("referenceNumber");

-- CreateIndex
CREATE INDEX "float_adjustment_requests_walletId_idx" ON "float_adjustment_requests"("walletId");

-- CreateIndex
CREATE INDEX "float_adjustment_requests_requestedBy_idx" ON "float_adjustment_requests"("requestedBy");

-- CreateIndex
CREATE INDEX "float_adjustment_requests_status_idx" ON "float_adjustment_requests"("status");

-- CreateIndex
CREATE INDEX "float_approvals_requestId_idx" ON "float_approvals"("requestId");

-- CreateIndex
CREATE INDEX "float_approvals_approvedBy_idx" ON "float_approvals"("approvedBy");

-- CreateIndex
CREATE UNIQUE INDEX "float_approvals_requestId_approvedBy_key" ON "float_approvals"("requestId", "approvedBy");

-- CreateIndex
CREATE INDEX "payment_methods_userId_idx" ON "payment_methods"("userId");

-- CreateIndex
CREATE INDEX "payment_methods_provider_phoneNumber_idx" ON "payment_methods"("provider", "phoneNumber");

-- CreateIndex
CREATE INDEX "daily_limits_userId_idx" ON "daily_limits"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_limits_userId_date_key" ON "daily_limits"("userId", "date");

-- AddForeignKey
ALTER TABLE "float_approvals" ADD CONSTRAINT "float_approvals_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "float_adjustment_requests"("requestId") ON DELETE CASCADE ON UPDATE CASCADE;
