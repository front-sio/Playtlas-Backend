ALTER TABLE club_payout_configs
  ADD COLUMN IF NOT EXISTS registration_bonus_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS registration_bonus_threshold DECIMAL(5,4) DEFAULT 0.50,
  ADD COLUMN IF NOT EXISTS registration_bonus_percent DECIMAL(6,4) DEFAULT 0.05;
