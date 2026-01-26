ALTER TABLE users
  ADD COLUMN IF NOT EXISTS registered_by_agent_id UUID;
