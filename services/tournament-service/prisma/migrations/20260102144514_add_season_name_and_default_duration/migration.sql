-- AlterTable
ALTER TABLE "seasons" ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "tournaments" ALTER COLUMN "seasonDuration" SET DEFAULT 1200;
