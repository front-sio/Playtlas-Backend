-- Add clubId to player_stats for club-level filtering
ALTER TABLE "player_stats" ADD COLUMN IF NOT EXISTS "clubId" UUID;
