ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS completed_by_agent_id UUID,
  ADD COLUMN IF NOT EXISTS completed_by_device_id UUID;
