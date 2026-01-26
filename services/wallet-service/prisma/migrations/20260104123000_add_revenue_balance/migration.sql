-- Add revenue balance tracking to wallets
ALTER TABLE "Wallet" ADD COLUMN "revenueBalance" DECIMAL(20,2) NOT NULL DEFAULT 0;
