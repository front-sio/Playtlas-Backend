/*
  Warnings:

  - You are about to drop the `wallets` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "wallets";

-- CreateTable
CREATE TABLE "Wallet" (
    "walletId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'player',
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "balance" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "locked" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "totalWins" INTEGER NOT NULL DEFAULT 0,
    "totalLosses" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("walletId")
);

-- CreateIndex
CREATE INDEX "Wallet_ownerId_idx" ON "Wallet"("ownerId");

-- CreateIndex
CREATE INDEX "Wallet_type_idx" ON "Wallet"("type");
