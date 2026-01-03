-- CreateTable
CREATE TABLE "agent_profiles" (
    "agentId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("agentId")
);

-- CreateTable
CREATE TABLE "agent_players" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_season_players" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentId" UUID NOT NULL,
    "seasonId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_season_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_season_payouts" (
    "payoutId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentId" UUID NOT NULL,
    "seasonId" UUID NOT NULL,
    "playerCount" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_season_payouts_pkey" PRIMARY KEY ("payoutId")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_profiles_userId_key" ON "agent_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_players_playerId_key" ON "agent_players"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_season_players_agentId_seasonId_playerId_key" ON "agent_season_players"("agentId", "seasonId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_season_payouts_agentId_seasonId_key" ON "agent_season_payouts"("agentId", "seasonId");

-- AddForeignKey
ALTER TABLE "agent_players" ADD CONSTRAINT "agent_players_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_profiles"("agentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_season_players" ADD CONSTRAINT "agent_season_players_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_profiles"("agentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_season_payouts" ADD CONSTRAINT "agent_season_payouts_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_profiles"("agentId") ON DELETE CASCADE ON UPDATE CASCADE;
