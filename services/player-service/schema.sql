-- Player Service Database Schema
-- Run: psql -d pool_game_player -f backend/services/player-service/schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS player_stats (
  player_id UUID PRIMARY KEY,
  username TEXT NOT NULL,
  total_matches INTEGER NOT NULL DEFAULT 0,
  matches_won INTEGER NOT NULL DEFAULT 0,
  matches_lost INTEGER NOT NULL DEFAULT 0,
  tournaments_played INTEGER NOT NULL DEFAULT 0,
  tournaments_won INTEGER NOT NULL DEFAULT 0,
  total_earnings NUMERIC(15, 2) NOT NULL DEFAULT 0,
  ranking_points INTEGER NOT NULL DEFAULT 1000,
  rank INTEGER,
  win_rate NUMERIC(5, 2),
  current_streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL,
  match_id UUID NOT NULL,
  tournament_id UUID NOT NULL,
  opponent_id UUID NOT NULL,
  result TEXT NOT NULL,
  points_change INTEGER NOT NULL DEFAULT 0,
  match_data JSONB,
  played_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS achievements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL,
  achievement_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  earned_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_stats_ranking ON player_stats(ranking_points DESC);
CREATE INDEX IF NOT EXISTS idx_match_history_player ON match_history(player_id);
CREATE INDEX IF NOT EXISTS idx_achievements_player ON achievements(player_id);
