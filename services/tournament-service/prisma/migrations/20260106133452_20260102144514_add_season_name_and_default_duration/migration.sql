/*
  Warnings:

  - You are about to drop the column `seasonDuration` on the `tournaments` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "tournaments" DROP COLUMN "seasonDuration",
ADD COLUMN     "season_duration" INTEGER NOT NULL DEFAULT 1200;
