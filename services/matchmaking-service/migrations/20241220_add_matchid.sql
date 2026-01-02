-- Add matchId to matches to satisfy Prisma model.
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS "matchId" UUID;

UPDATE matches
  SET "matchId" = gen_random_uuid()
  WHERE "matchId" IS NULL;

ALTER TABLE matches
  ALTER COLUMN "matchId" SET NOT NULL;

ALTER TABLE matches
  ALTER COLUMN "matchId" SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS matches_matchId_key ON matches ("matchId");
