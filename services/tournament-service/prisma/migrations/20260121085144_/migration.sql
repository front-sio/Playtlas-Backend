/*
  Warnings:

  - You are about to drop the column `completed_at` on the `seasons` table. All the data in the column will be lost.
  - You are about to drop the column `error_reason` on the `seasons` table. All the data in the column will be lost.
  - You are about to drop the column `final_match_id` on the `seasons` table. All the data in the column will be lost.
  - You are about to drop the column `finalized_by_job_id` on the `seasons` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "seasons" DROP COLUMN "completed_at",
DROP COLUMN "error_reason",
DROP COLUMN "final_match_id",
DROP COLUMN "finalized_by_job_id",
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "errorReason" TEXT,
ADD COLUMN     "finalMatchId" UUID,
ADD COLUMN     "finalizedByJobId" TEXT;

-- AlterTable
ALTER TABLE "tournaments" ADD COLUMN     "match_duration_minutes" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "operating_hours_end" TEXT NOT NULL DEFAULT '23:00:00',
ADD COLUMN     "operating_hours_start" TEXT NOT NULL DEFAULT '11:00:00';

-- CreateTable
CREATE TABLE "group_standings" (
    "standing_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "season_id" UUID NOT NULL,
    "group_label" VARCHAR(1) NOT NULL,
    "player_id" UUID NOT NULL,
    "matches_played" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "points_for" INTEGER NOT NULL DEFAULT 0,
    "points_against" INTEGER NOT NULL DEFAULT 0,
    "win_percentage" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "point_difference" INTEGER NOT NULL DEFAULT 0,
    "group_position" INTEGER,
    "qualified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_standings_pkey" PRIMARY KEY ("standing_id")
);

-- CreateTable
CREATE TABLE "device_schedules" (
    "schedule_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" UUID NOT NULL,
    "club_id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "match_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_schedules_pkey" PRIMARY KEY ("schedule_id")
);

-- CreateTable
CREATE TABLE "bracket_matches" (
    "bracket_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "season_id" UUID NOT NULL,
    "round" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "match_id" UUID,
    "bracket_level" INTEGER NOT NULL,
    "parent_match_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bracket_matches_pkey" PRIMARY KEY ("bracket_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_standings_season_id_group_label_player_id_key" ON "group_standings"("season_id", "group_label", "player_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_schedules_device_id_start_time_key" ON "device_schedules"("device_id", "start_time");

-- CreateIndex
CREATE UNIQUE INDEX "bracket_matches_match_id_key" ON "bracket_matches"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "bracket_matches_season_id_round_position_key" ON "bracket_matches"("season_id", "round", "position");

-- AddForeignKey
ALTER TABLE "group_standings" ADD CONSTRAINT "group_standings_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("seasonId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_schedules" ADD CONSTRAINT "device_schedules_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("seasonId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bracket_matches" ADD CONSTRAINT "bracket_matches_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("seasonId") ON DELETE CASCADE ON UPDATE CASCADE;
