-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "assignedAgentId" UUID,
ADD COLUMN     "assignedAgentUserId" UUID,
ADD COLUMN     "assignedDeviceId" UUID,
ADD COLUMN     "bracketGroup" TEXT,
ADD COLUMN     "clubId" UUID,
ADD COLUMN     "round" TEXT,
ADD COLUMN     "scheduledStartAt" TIMESTAMP(3),
ADD COLUMN     "winnerAdvancesToMatchId" UUID,
ADD COLUMN     "winnerAdvancesToSlot" TEXT;
