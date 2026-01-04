-- CreateTable
CREATE TABLE "matches" (
    "matchId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournamentId" UUID NOT NULL,
    "seasonId" UUID,
    "stage" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "player1Id" UUID NOT NULL,
    "player2Id" UUID NOT NULL,
    "player1Score" INTEGER NOT NULL DEFAULT 0,
    "player2Score" INTEGER NOT NULL DEFAULT 0,
    "winnerId" UUID,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduledTime" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "gameSessionId" TEXT,
    "gameServerUrl" TEXT,
    "player1Ready" BOOLEAN NOT NULL DEFAULT false,
    "player2Ready" BOOLEAN NOT NULL DEFAULT false,
    "player1ConnectionTime" TIMESTAMP(3),
    "player2ConnectionTime" TIMESTAMP(3),
    "suspiciousActivity" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("matchId")
);

-- CreateTable
CREATE TABLE "players" (
    "playerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "players_pkey" PRIMARY KEY ("playerId")
);

-- CreateTable
CREATE TABLE "match_queue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "playerId" UUID NOT NULL,
    "tournamentId" UUID,
    "seasonId" UUID,
    "round" INTEGER,
    "playerRating" INTEGER NOT NULL DEFAULT 1000,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "matchedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_queue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "match_queue_playerId_key" ON "match_queue"("playerId");
CREATE INDEX "match_queue_status_idx" ON "match_queue"("status");
CREATE INDEX "match_queue_tournamentId_seasonId_round_idx" ON "match_queue"("tournamentId", "seasonId", "round");
