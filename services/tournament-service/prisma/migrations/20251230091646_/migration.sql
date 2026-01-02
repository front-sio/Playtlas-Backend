-- CreateTable
CREATE TABLE "tournaments" (
    "tournamentId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "entryFee" DECIMAL(15,2) NOT NULL,
    "maxPlayers" INTEGER NOT NULL DEFAULT 32,
    "currentPlayers" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'upcoming',
    "stage" TEXT NOT NULL DEFAULT 'registration',
    "competitionWalletId" UUID,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "seasonDuration" INTEGER NOT NULL DEFAULT 3600,
    "winnerId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("tournamentId")
);

-- CreateTable
CREATE TABLE "seasons" (
    "seasonId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournamentId" UUID NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "joiningClosed" BOOLEAN NOT NULL DEFAULT false,
    "matchesGenerated" BOOLEAN NOT NULL DEFAULT false,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("seasonId")
);

-- CreateTable
CREATE TABLE "tournament_players" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournamentId" UUID NOT NULL,
    "seasonId" UUID,
    "playerId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'registered',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eliminatedAt" TIMESTAMP(3),

    CONSTRAINT "tournament_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_command_logs" (
    "commandId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tournamentId" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_command_logs_pkey" PRIMARY KEY ("commandId")
);

-- AddForeignKey
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("tournamentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("tournamentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("seasonId") ON DELETE CASCADE ON UPDATE CASCADE;
