-- Tournament Service Database Schema
-- Run: psql -d pool_game_tournament -f backend/services/tournament-service/schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS tournaments (
  tournament_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  entry_fee NUMERIC(15, 2) NOT NULL,
  max_players INTEGER NOT NULL DEFAULT 32,
  current_players INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'upcoming',
  stage TEXT NOT NULL DEFAULT 'registration',
  competition_wallet_id UUID,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  season_duration INTEGER NOT NULL DEFAULT 3600,
  winner_id UUID,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seasons (
  season_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id UUID NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tournament_players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id UUID NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  player_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  registered_at TIMESTAMP NOT NULL DEFAULT NOW(),
  eliminated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS matches (
  match_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id UUID NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
  season_id UUID REFERENCES seasons(season_id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  player1_id UUID NOT NULL,
  player2_id UUID NOT NULL,
  winner_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  match_data JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
CREATE INDEX IF NOT EXISTS idx_tournament_players_tournament ON tournament_players(tournament_id);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
