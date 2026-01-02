/*
  Warnings:

  - You are about to drop the `deposit_requests` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `payouts` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "deposit_requests" DROP CONSTRAINT "deposit_requests_walletId_fkey";

-- DropForeignKey
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_walletId_fkey";

-- DropTable
DROP TABLE "deposit_requests";

-- DropTable
DROP TABLE "payouts";
