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

-- CreateIndex
CREATE UNIQUE INDEX "match_queue_playerId_key" ON "match_queue"("playerId");

-- CreateIndex
CREATE INDEX "match_queue_status_idx" ON "match_queue"("status");

-- CreateIndex
CREATE INDEX "match_queue_tournamentId_seasonId_round_idx" ON "match_queue"("tournamentId", "seasonId", "round");
