-- Remove AI-related functionality and add club device support
-- Migration: remove_ai_add_club_devices

BEGIN;

-- Remove AI-related tables
DROP TABLE IF EXISTS "match_frame_logs" CASCADE;
DROP TABLE IF EXISTS "ai_win_rate_stats" CASCADE;  
DROP TABLE IF EXISTS "ai_profiles" CASCADE;

-- Remove AI-related columns from matches table
ALTER TABLE "matches" DROP COLUMN IF EXISTS "with_ai";
ALTER TABLE "matches" DROP COLUMN IF EXISTS "ai_player_id";  
ALTER TABLE "matches" DROP COLUMN IF EXISTS "ai_profile_id";
ALTER TABLE "matches" DROP COLUMN IF EXISTS "match_seed";
ALTER TABLE "matches" DROP COLUMN IF EXISTS "match_result";
ALTER TABLE "matches" DROP COLUMN IF EXISTS "ended_at";

-- Add club-based game columns
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "game_data" JSONB;
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "match_duration" INTEGER;
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "end_reason" TEXT;

-- Create club devices table for device-based gameplay
CREATE TABLE IF NOT EXISTS "club_devices" (
  "device_id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "club_id" UUID NOT NULL,
  "device_name" TEXT NOT NULL,
  "location" TEXT,
  "is_active" BOOLEAN DEFAULT TRUE,
  "current_match_id" UUID,
  "last_used" TIMESTAMP,
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_club_devices_club_active" ON "club_devices"("club_id", "is_active");

-- Add trigger for updated_at on club_devices
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_club_devices_updated_at ON "club_devices";
CREATE TRIGGER update_club_devices_updated_at
    BEFORE UPDATE ON "club_devices"
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;