-- AlterTable
ALTER TABLE "game_sessions" ADD COLUMN     "player1ConnectionTime" TIMESTAMP(3),
ADD COLUMN     "player1Ready" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "player2ConnectionTime" TIMESTAMP(3),
ADD COLUMN     "player2Ready" BOOLEAN NOT NULL DEFAULT false;
