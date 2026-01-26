-- AI Match Enhancement Migration
-- Add frame logging and improve matchmaking for AI matches

-- Add frame logging table for hybrid logging support
CREATE TABLE IF NOT EXISTS match_frame_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
    frame_data JSONB NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    shot_sequence INTEGER,
    game_state JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for efficient frame log queries
CREATE INDEX IF NOT EXISTS idx_match_frame_logs_match_timestamp ON match_frame_logs(match_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_match_frame_logs_match_shot ON match_frame_logs(match_id, shot_sequence);

-- Add match_id column to match_queue for better tracking
ALTER TABLE match_queue ADD COLUMN IF NOT EXISTS match_id UUID;
ALTER TABLE match_queue ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Add index for better queue performance
CREATE INDEX IF NOT EXISTS idx_match_queue_player_status ON match_queue(player_id, status);

-- Add AI match tracking columns to matches table if not exists
-- (metadata column already exists to store AI settings)

COMMENT ON TABLE match_frame_logs IS 'Stores frame-by-frame game data for match analysis and replay';
COMMENT ON COLUMN match_frame_logs.frame_data IS 'Ball positions, physics state, and other game data for this frame';
COMMENT ON COLUMN match_frame_logs.shot_sequence IS 'Which shot sequence this frame belongs to';
COMMENT ON COLUMN match_frame_logs.game_state IS 'Score, turn, and game state at this frame';