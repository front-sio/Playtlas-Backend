-- CreateTable
CREATE TABLE "game_sessions" (
    "sessionId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tableId" UUID,
    "player1Id" UUID NOT NULL,
    "player2Id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "metadata" JSONB,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("sessionId")
);
