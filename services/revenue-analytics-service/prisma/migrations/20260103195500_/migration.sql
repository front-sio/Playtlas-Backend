-- CreateTable
CREATE TABLE "PlatformRevenue" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "period" TEXT NOT NULL,
    "tournamentFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "depositFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "withdrawalFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transferFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformRevenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueByProvider" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "depositRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "withdrawalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transactionFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueByProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueByTournament" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "tournamentName" TEXT,
    "date" DATE NOT NULL,
    "entryFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "platformFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "playersCount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueByTournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRevenue" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentName" TEXT,
    "date" DATE NOT NULL,
    "period" TEXT NOT NULL,
    "commissionEarned" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "playersRegistered" INTEGER NOT NULL DEFAULT 0,
    "activePlayers" INTEGER NOT NULL DEFAULT 0,
    "totalDeposits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalWithdrawals" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "playerRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRevenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerRevenue" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "username" TEXT,
    "agentId" TEXT,
    "agentName" TEXT,
    "date" DATE NOT NULL,
    "period" TEXT NOT NULL,
    "totalWinnings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalLosses" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feesPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netProfit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDeposits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalWithdrawals" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "tournamentsPlayed" INTEGER NOT NULL DEFAULT 0,
    "lifetimeValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "profitabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerRevenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueAlert" (
    "id" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metricName" TEXT NOT NULL,
    "thresholdValue" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION,
    "percentageChange" DOUBLE PRECISION,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledReport" (
    "id" TEXT NOT NULL,
    "reportName" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "recipients" TEXT[],
    "parameters" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregationJob" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "recordsProcessed" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AggregationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformRevenue_date_idx" ON "PlatformRevenue"("date");

-- CreateIndex
CREATE INDEX "PlatformRevenue_period_idx" ON "PlatformRevenue"("period");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformRevenue_date_period_key" ON "PlatformRevenue"("date", "period");

-- CreateIndex
CREATE INDEX "RevenueByProvider_provider_idx" ON "RevenueByProvider"("provider");

-- CreateIndex
CREATE INDEX "RevenueByProvider_date_idx" ON "RevenueByProvider"("date");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueByProvider_provider_date_key" ON "RevenueByProvider"("provider", "date");

-- CreateIndex
CREATE INDEX "RevenueByTournament_tournamentId_idx" ON "RevenueByTournament"("tournamentId");

-- CreateIndex
CREATE INDEX "RevenueByTournament_date_idx" ON "RevenueByTournament"("date");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueByTournament_tournamentId_date_key" ON "RevenueByTournament"("tournamentId", "date");

-- CreateIndex
CREATE INDEX "AgentRevenue_agentId_idx" ON "AgentRevenue"("agentId");

-- CreateIndex
CREATE INDEX "AgentRevenue_date_idx" ON "AgentRevenue"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRevenue_agentId_date_period_key" ON "AgentRevenue"("agentId", "date", "period");

-- CreateIndex
CREATE INDEX "PlayerRevenue_playerId_idx" ON "PlayerRevenue"("playerId");

-- CreateIndex
CREATE INDEX "PlayerRevenue_agentId_idx" ON "PlayerRevenue"("agentId");

-- CreateIndex
CREATE INDEX "PlayerRevenue_date_idx" ON "PlayerRevenue"("date");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerRevenue_playerId_date_period_key" ON "PlayerRevenue"("playerId", "date", "period");

-- CreateIndex
CREATE INDEX "RevenueAlert_alertType_idx" ON "RevenueAlert"("alertType");

-- CreateIndex
CREATE INDEX "RevenueAlert_isResolved_idx" ON "RevenueAlert"("isResolved");

-- CreateIndex
CREATE INDEX "RevenueAlert_createdAt_idx" ON "RevenueAlert"("createdAt");

-- CreateIndex
CREATE INDEX "ScheduledReport_reportType_idx" ON "ScheduledReport"("reportType");

-- CreateIndex
CREATE INDEX "ScheduledReport_isActive_idx" ON "ScheduledReport"("isActive");

-- CreateIndex
CREATE INDEX "AggregationJob_jobType_idx" ON "AggregationJob"("jobType");

-- CreateIndex
CREATE INDEX "AggregationJob_status_idx" ON "AggregationJob"("status");

-- CreateIndex
CREATE INDEX "AggregationJob_startDate_idx" ON "AggregationJob"("startDate");
