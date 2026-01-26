ALTER TABLE club_payout_configs
  ADD COLUMN IF NOT EXISTS base_pay_uptime_threshold DECIMAL(5,4) DEFAULT 0.90;
