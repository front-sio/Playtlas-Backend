-- Add clubId to users for agent/player association
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "clubId" UUID;
