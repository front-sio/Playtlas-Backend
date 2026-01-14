-- AlterTable
ALTER TABLE "game_sessions" ADD COLUMN     "player1Connected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "player2Connected" BOOLEAN NOT NULL DEFAULT false;
