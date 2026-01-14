-- AlterTable
ALTER TABLE "game_sessions" ADD COLUMN     "gameState" JSONB,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3);
