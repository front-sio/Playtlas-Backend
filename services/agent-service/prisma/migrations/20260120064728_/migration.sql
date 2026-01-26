/*
  Warnings:

  - Added the required column `clubId` to the `agent_profiles` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "agent_profiles" ADD COLUMN     "clubId" UUID NOT NULL,
ADD COLUMN     "deviceLabel" TEXT;

-- CreateTable
CREATE TABLE "devices" (
    "deviceId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentId" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "capacitySlots" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("deviceId")
);

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_profiles"("agentId") ON DELETE CASCADE ON UPDATE CASCADE;
