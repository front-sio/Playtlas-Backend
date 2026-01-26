/*
  Warnings:

  - Added the required column `clubId` to the `seasons` table without a default value. This is not possible if the table is not empty.
  - Added the required column `clubId` to the `tournaments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "seasons" ADD COLUMN     "clubId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "tournaments" ADD COLUMN     "clubId" UUID NOT NULL;

-- CreateTable
CREATE TABLE "clubs" (
    "clubId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "locationText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clubs_pkey" PRIMARY KEY ("clubId")
);

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("clubId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("clubId") ON DELETE RESTRICT ON UPDATE CASCADE;
