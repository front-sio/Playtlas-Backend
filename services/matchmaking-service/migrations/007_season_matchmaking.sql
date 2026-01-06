-- Season Queue and Enhanced Match System
-- Migration: Add season-based matchmaking tables

-- Season Queue table for matchmaking
CREATE TABLE IF NOT EXISTS season_queue (
    queue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    season_id UUID NOT NULL REFERENCES seasons(season_id),
    player_id UUID NOT NULL REFERENCES players(player_id),
    status VARCHAR(20) NOT NULL DEFAULT 'waiting',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    left_at TIMESTAMP NULL,
    match_id UUID NULL REFERENCES matches(match_id),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_season_queue_season_status ON season_queue(season_id, status);
CREATE INDEX IF NOT EXISTS idx_season_queue_player ON season_queue(player_id);
CREATE INDEX IF NOT EXISTS idx_season_queue_joined_at ON season_queue(joined_at);

-- Enhanced Match table (add new columns if they don't exist)
DO $$ 
BEGIN
    -- Add scheduled_at column for match scheduling
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'matches' AND column_name = 'scheduled_at') THEN
        ALTER TABLE matches ADD COLUMN scheduled_at TIMESTAMP NULL;
    END IF;
    
    -- Add game_session_id for linking to game sessions
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'matches' AND column_name = 'game_session_id') THEN
        ALTER TABLE matches ADD COLUMN game_session_id VARCHAR(255) NULL;
    END IF;
    
    -- Add match duration and time tracking
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'matches' AND column_name = 'duration_seconds') THEN
        ALTER TABLE matches ADD COLUMN duration_seconds INTEGER NULL;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'matches' AND column_name = 'time_expired') THEN
        ALTER TABLE matches ADD COLUMN time_expired BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Game Sessions table (enhanced for match support)
DO $$
BEGIN
    -- Add match_id reference to game sessions
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'game_sessions' AND column_name = 'match_id') THEN
        ALTER TABLE game_sessions ADD COLUMN match_id UUID NULL REFERENCES matches(match_id);
    END IF;
    
    -- Add timer information
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'game_sessions' AND column_name = 'max_duration_seconds') THEN
        ALTER TABLE game_sessions ADD COLUMN max_duration_seconds INTEGER DEFAULT 300;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'game_sessions' AND column_name = 'time_remaining') THEN
        ALTER TABLE game_sessions ADD COLUMN time_remaining INTEGER NULL;
    END IF;
END $$;

-- Create trigger for updating season_queue.updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_season_queue_updated_at ON season_queue;
CREATE TRIGGER update_season_queue_updated_at
    BEFORE UPDATE ON season_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Insert sample data for testing
INSERT INTO seasons (season_id, tournament_id, name, status, start_date, end_date, metadata) 
VALUES (
    'season-winter-2024',
    'tournament-1',
    'Winter Season 2024',
    'active',
    CURRENT_DATE,
    CURRENT_DATE + INTERVAL '90 days',
    '{"description": "Winter championship season", "max_players": 1000, "match_duration": 300}'
) ON CONFLICT (season_id) DO NOTHING;

-- Sample players for testing
INSERT INTO players (player_id, username, email, status)
VALUES 
    ('player-test-1', 'TestPlayer1', 'test1@example.com', 'active'),
    ('player-test-2', 'TestPlayer2', 'test2@example.com', 'active'),
    ('player-test-3', 'TestPlayer3', 'test3@example.com', 'active'),
    ('player-test-4', 'TestPlayer4', 'test4@example.com', 'active')
ON CONFLICT (player_id) DO NOTHING;

-- Comments for documentation
COMMENT ON TABLE season_queue IS 'Matchmaking queue for seasons - players join and get matched';
COMMENT ON COLUMN season_queue.status IS 'Queue status: waiting, matched, left';
COMMENT ON COLUMN matches.scheduled_at IS 'When the match is scheduled to start';
COMMENT ON COLUMN matches.duration_seconds IS 'Actual match duration in seconds';
COMMENT ON COLUMN matches.time_expired IS 'Whether match ended due to time limit';

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_matches_scheduled_at ON matches(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_matches_game_session ON matches(game_session_id);
CREATE INDEX IF NOT EXISTS idx_game_sessions_match_id ON game_sessions(match_id);

-- View for active queue status
CREATE OR REPLACE VIEW active_season_queues AS
SELECT 
    sq.season_id,
    s.name as season_name,
    COUNT(CASE WHEN sq.status = 'waiting' THEN 1 END) as players_waiting,
    COUNT(CASE WHEN sq.status = 'matched' THEN 1 END) as players_matched,
    MIN(sq.joined_at) as oldest_waiting_since,
    MAX(sq.joined_at) as newest_joined_at
FROM season_queue sq
JOIN seasons s ON sq.season_id = s.season_id
WHERE s.status = 'active'
GROUP BY sq.season_id, s.name;

COMMENT ON VIEW active_season_queues IS 'Real-time view of matchmaking queue status per active season';

-- Function to clean up old queue entries
CREATE OR REPLACE FUNCTION cleanup_old_queue_entries()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete queue entries older than 24 hours that are not active
    DELETE FROM season_queue 
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'
    AND status NOT IN ('waiting', 'matched');
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_queue_entries() IS 'Cleanup function to remove old non-active queue entries';

COMMIT;