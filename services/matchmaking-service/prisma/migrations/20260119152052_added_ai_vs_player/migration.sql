-- CreateEnum
CREATE TYPE "MatchResult" AS ENUM ('AI_WIN', 'HUMAN_WIN', 'DRAW', 'ABANDONED');

-- AlterTable
ALTER TABLE "match_queue" ADD COLUMN     "matchId" UUID,
ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "ai_player_id" UUID,
ADD COLUMN     "ai_profile_id" UUID,
ADD COLUMN     "ended_at" TIMESTAMP(3),
ADD COLUMN     "match_result" "MatchResult",
ADD COLUMN     "match_seed" TEXT,
ADD COLUMN     "with_ai" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ai_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "skillLevel" INTEGER NOT NULL,
    "errorDegrees" DOUBLE PRECISION NOT NULL,
    "powerVariance" DOUBLE PRECISION NOT NULL,
    "missChance" DOUBLE PRECISION NOT NULL,
    "think_time_ms" INTEGER NOT NULL,
    "safety_play_chance" DOUBLE PRECISION NOT NULL,
    "trials_per_shot" INTEGER NOT NULL,
    "expected_win_rate" DOUBLE PRECISION NOT NULL,
    "entry_fee_tier" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_win_rate_stats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ai_profile_id" UUID NOT NULL,
    "entry_fee_tier" INTEGER NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "total_matches" INTEGER NOT NULL DEFAULT 0,
    "ai_wins" INTEGER NOT NULL DEFAULT 0,
    "current_streak" INTEGER NOT NULL DEFAULT 0,
    "rolling_win_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "target_win_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.52,
    "last_match_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_win_rate_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_frame_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "matchId" UUID NOT NULL,
    "frameData" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "shotSequence" INTEGER,
    "gameState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_frame_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_profiles_entry_fee_tier_is_active_idx" ON "ai_profiles"("entry_fee_tier", "is_active");

-- CreateIndex
CREATE INDEX "ai_win_rate_stats_entry_fee_tier_last_match_at_idx" ON "ai_win_rate_stats"("entry_fee_tier", "last_match_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_win_rate_stats_ai_profile_id_entry_fee_tier_key" ON "ai_win_rate_stats"("ai_profile_id", "entry_fee_tier");

-- CreateIndex
CREATE INDEX "match_frame_logs_matchId_timestamp_idx" ON "match_frame_logs"("matchId", "timestamp");

-- CreateIndex
CREATE INDEX "match_frame_logs_matchId_shotSequence_idx" ON "match_frame_logs"("matchId", "shotSequence");

-- CreateIndex
CREATE INDEX "match_queue_playerId_status_idx" ON "match_queue"("playerId", "status");

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_ai_profile_id_fkey" FOREIGN KEY ("ai_profile_id") REFERENCES "ai_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_win_rate_stats" ADD CONSTRAINT "ai_win_rate_stats_ai_profile_id_fkey" FOREIGN KEY ("ai_profile_id") REFERENCES "ai_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_frame_logs" ADD CONSTRAINT "match_frame_logs_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("matchId") ON DELETE CASCADE ON UPDATE CASCADE;
