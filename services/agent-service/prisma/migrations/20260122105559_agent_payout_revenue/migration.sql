-- AlterTable
ALTER TABLE "agent_profiles" ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'offline';

-- CreateTable
CREATE TABLE "agent_shifts" (
    "shift_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "shift_date" DATE NOT NULL,
    "start_time" TIME,
    "end_time" TIME,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "actual_start_time" TIMESTAMP(3),
    "actual_end_time" TIMESTAMP(3),
    "base_pay_amount" DECIMAL(10,2) NOT NULL,
    "uptime_percentage" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_shifts_pkey" PRIMARY KEY ("shift_id")
);

-- CreateTable
CREATE TABLE "club_revenue_daily" (
    "revenue_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "revenue_date" DATE NOT NULL,
    "total_entry_fees" DECIMAL(12,2) NOT NULL,
    "total_platform_fees" DECIMAL(12,2) NOT NULL,
    "total_seasons" INTEGER NOT NULL DEFAULT 0,
    "total_matches" INTEGER NOT NULL DEFAULT 0,
    "completed_matches" INTEGER NOT NULL DEFAULT 0,
    "agent_share_percent" DECIMAL(5,4) NOT NULL,
    "agent_pool_amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finalized_at" TIMESTAMP(3),
    "finalized_by" UUID,

    CONSTRAINT "club_revenue_daily_pkey" PRIMARY KEY ("revenue_id")
);

-- CreateTable
CREATE TABLE "agent_earnings_daily" (
    "earnings_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "earnings_date" DATE NOT NULL,
    "base_pay_amount" DECIMAL(10,2) NOT NULL,
    "revenue_share_amount" DECIMAL(10,2) NOT NULL,
    "bonus_amount" DECIMAL(10,2) NOT NULL,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "matches_completed" INTEGER NOT NULL DEFAULT 0,
    "uptime_minutes" INTEGER NOT NULL DEFAULT 0,
    "uptime_percentage" DECIMAL(5,2) NOT NULL,
    "match_weight" DECIMAL(8,4) NOT NULL,
    "uptime_weight" DECIMAL(8,4) NOT NULL,
    "total_weight" DECIMAL(8,4) NOT NULL,
    "weight_percentage" DECIMAL(5,4) NOT NULL,
    "computed_from" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finalized_at" TIMESTAMP(3),
    "finalized_by" UUID,
    "paid_at" TIMESTAMP(3),
    "paid_by" UUID,

    CONSTRAINT "agent_earnings_daily_pkey" PRIMARY KEY ("earnings_id")
);

-- CreateTable
CREATE TABLE "payout_transactions" (
    "transaction_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'WALLET',
    "reference_id" TEXT,
    "recipient_details" JSONB,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "initiated_by" UUID,
    "processed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payout_transactions_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "agent_contribution_logs" (
    "log_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "contribution_date" DATE NOT NULL,
    "match_id" UUID,
    "device_id" UUID,
    "match_started_at" TIMESTAMP(3),
    "match_completed_at" TIMESTAMP(3),
    "match_duration_seconds" INTEGER,
    "match_entry_fee" DECIMAL(10,2) NOT NULL,
    "match_platform_fee" DECIMAL(10,2) NOT NULL,
    "contribution_weight" DECIMAL(8,4) NOT NULL,
    "contribution_type" TEXT NOT NULL DEFAULT 'MATCH',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_contribution_logs_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "club_payout_configs" (
    "config_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "base_pay_amount" DECIMAL(10,2) NOT NULL,
    "base_pay_currency" TEXT NOT NULL DEFAULT 'TSH',
    "base_pay_uptime_threshold" DECIMAL(5,4) NOT NULL,
    "agent_share_percent" DECIMAL(5,4) NOT NULL,
    "weight_by_matches" BOOLEAN NOT NULL DEFAULT true,
    "weight_by_uptime" BOOLEAN NOT NULL DEFAULT false,
    "match_weight_percent" DECIMAL(3,2) NOT NULL,
    "uptime_weight_percent" DECIMAL(3,2) NOT NULL,
    "uptime_bonus_enabled" BOOLEAN NOT NULL DEFAULT true,
    "uptime_bonus_threshold" DECIMAL(3,2) NOT NULL,
    "uptime_bonus_amount" DECIMAL(10,2) NOT NULL,
    "attendance_bonus_enabled" BOOLEAN NOT NULL DEFAULT true,
    "attendance_bonus_amount" DECIMAL(10,2) NOT NULL,
    "quality_bonus_enabled" BOOLEAN NOT NULL DEFAULT false,
    "quality_bonus_amount" DECIMAL(10,2) NOT NULL,
    "registration_bonus_enabled" BOOLEAN NOT NULL DEFAULT true,
    "registration_bonus_threshold" DECIMAL(5,4) NOT NULL,
    "registration_bonus_percent" DECIMAL(6,4) NOT NULL,
    "payout_frequency" TEXT NOT NULL DEFAULT 'DAILY',
    "auto_payout_enabled" BOOLEAN NOT NULL DEFAULT false,
    "min_payout_amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "club_payout_configs_pkey" PRIMARY KEY ("config_id")
);

-- CreateTable
CREATE TABLE "earnings_audit_log" (
    "audit_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "club_id" UUID NOT NULL,
    "audit_date" DATE NOT NULL,
    "event_type" TEXT NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "earnings_audit_log_pkey" PRIMARY KEY ("audit_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_shifts_club_id_agent_id_shift_date_key" ON "agent_shifts"("club_id", "agent_id", "shift_date");

-- CreateIndex
CREATE UNIQUE INDEX "club_revenue_daily_club_id_revenue_date_key" ON "club_revenue_daily"("club_id", "revenue_date");

-- CreateIndex
CREATE UNIQUE INDEX "agent_earnings_daily_club_id_agent_id_earnings_date_key" ON "agent_earnings_daily"("club_id", "agent_id", "earnings_date");

-- CreateIndex
CREATE UNIQUE INDEX "club_payout_configs_club_id_key" ON "club_payout_configs"("club_id");
