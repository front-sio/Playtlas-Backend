-- Migration: Add game_shots table for authoritative server
-- This stores every shot executed on the server for audit/replay

CREATE TABLE IF NOT EXISTS game_shots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL,
  shot_number INTEGER NOT NULL,
  player_id VARCHAR(50) NOT NULL, -- 'p1', 'p2', or 'ai'
  
  -- Shot input
  direction_x DECIMAL(10,8) NOT NULL,
  direction_y DECIMAL(10,8) NOT NULL,
  power DECIMAL(10,2) NOT NULL,
  cue_ball_x DECIMAL(10,2),
  cue_ball_y DECIMAL(10,2),
  screw DECIMAL(5,4),
  english DECIMAL(5,4),
  
  -- Shot result
  result_state JSONB NOT NULL,
  pocketed_balls INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  fouls TEXT[] DEFAULT ARRAY[]::TEXT[],
  first_contact INTEGER,
  state_hash VARCHAR(64) NOT NULL,
  
  -- Timing & metadata
  execution_time INTEGER, -- Milliseconds to calculate
  executed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  UNIQUE(match_id, shot_number)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_game_shots_match ON game_shots(match_id);
CREATE INDEX IF NOT EXISTS idx_game_shots_executed ON game_shots(executed_at);
CREATE INDEX IF NOT EXISTS idx_game_shots_hash ON game_shots(state_hash);

-- Add comment
COMMENT ON TABLE game_shots IS 'Server-authoritative shot recording for audit and replay';
