-- Club-based Tournament System Migration
-- Adds comprehensive support for device-routed matches, scheduling, and brackets

BEGIN;

-- Update tournament schema for club-based system
ALTER TABLE tournaments 
  ADD COLUMN IF NOT EXISTS operating_hours_start TIME DEFAULT '11:00:00',
  ADD COLUMN IF NOT EXISTS operating_hours_end TIME DEFAULT '23:00:00',
  ADD COLUMN IF NOT EXISTS match_duration_minutes INT DEFAULT 5;

-- Add comprehensive match table for tournament system
CREATE TABLE IF NOT EXISTS matches (
  match_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  club_id UUID NOT NULL,
  
  -- Match identification
  round VARCHAR(20) NOT NULL, -- 'GROUP', 'R16', 'QF', 'SF', 'FINAL'
  group_label VARCHAR(1), -- 'A' through 'H' for group matches
  match_number INT NOT NULL,
  
  -- Players
  player1_id UUID,
  player2_id UUID,
  winner_id UUID,
  
  -- Scores
  player1_score INT DEFAULT 0,
  player2_score INT DEFAULT 0,
  
  -- Scheduling
  scheduled_start_at TIMESTAMP,
  assigned_device_id UUID,
  assigned_agent_id UUID,
  
  -- Status
  status VARCHAR(20) DEFAULT 'SCHEDULED', -- SCHEDULED, READY, IN_PROGRESS, COMPLETED, CANCELLED
  
  -- Tournament progression
  winner_advances_to_match_id UUID,
  winner_advances_to_slot VARCHAR(10), -- 'A' or 'B' (player1 or player2)
  
  -- Match data
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  match_duration_seconds INT,
  end_reason VARCHAR(50),
  game_data JSONB,
  
  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_matches_season ON matches(season_id, round, group_label);
CREATE INDEX IF NOT EXISTS idx_matches_schedule ON matches(scheduled_start_at, assigned_device_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, scheduled_start_at);
CREATE INDEX IF NOT EXISTS idx_matches_device ON matches(assigned_device_id, scheduled_start_at);

-- Group standings table for tracking group stage progress
CREATE TABLE IF NOT EXISTS group_standings (
  standing_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  group_label VARCHAR(1) NOT NULL,
  player_id UUID NOT NULL,
  
  -- Stats
  matches_played INT DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  points_for INT DEFAULT 0,
  points_against INT DEFAULT 0,
  
  -- Calculated fields
  win_percentage DECIMAL(5,4) DEFAULT 0,
  point_difference INT DEFAULT 0,
  
  -- Ranking
  group_position INT,
  qualified BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(season_id, group_label, player_id)
);

CREATE INDEX IF NOT EXISTS idx_group_standings_season_group ON group_standings(season_id, group_label, group_position);

-- Device schedule table for tracking device availability
CREATE TABLE IF NOT EXISTS device_schedules (
  schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL,
  club_id UUID NOT NULL,
  
  -- Time slot
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  
  -- Assignment
  match_id UUID,
  status VARCHAR(20) DEFAULT 'AVAILABLE', -- AVAILABLE, BOOKED, IN_USE, MAINTENANCE
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(device_id, start_time)
);

CREATE INDEX IF NOT EXISTS idx_device_schedules_device_time ON device_schedules(device_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_device_schedules_club_time ON device_schedules(club_id, start_time);

-- Tournament bracket visualization data
CREATE TABLE IF NOT EXISTS bracket_matches (
  bracket_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL REFERENCES seasons(season_id) ON DELETE CASCADE,
  round VARCHAR(20) NOT NULL,
  position INT NOT NULL, -- Position in bracket (1-8 for R16, 1-4 for QF, etc.)
  
  -- Match reference
  match_id UUID,
  
  -- Bracket metadata for visualization
  bracket_level INT NOT NULL, -- 1=Final, 2=SF, 3=QF, 4=R16
  parent_match_id UUID, -- Which match this feeds into
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(season_id, round, position)
);

CREATE INDEX IF NOT EXISTS idx_bracket_matches_season_round ON bracket_matches(season_id, round, bracket_level);

COMMIT;