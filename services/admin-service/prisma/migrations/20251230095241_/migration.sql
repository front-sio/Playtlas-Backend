-- CreateTable
CREATE TABLE "admin_users" (
    "adminId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLogin" TIMESTAMP(3),
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("adminId")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "logId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "adminId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" UUID,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("logId")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "settingId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("settingId")
);

-- CreateTable
CREATE TABLE "reports" (
    "reportId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reportType" TEXT NOT NULL,
    "generatedBy" UUID NOT NULL,
    "parameters" JSONB,
    "data" JSONB,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("reportId")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "approval_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by_user_id" UUID NOT NULL,
    "requested_by_role" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_user_id" UUID,
    "approved_by_role" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejected_by_user_id" UUID,
    "rejected_by_role" TEXT,
    "rejected_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "command_id" TEXT,
    "bypass_requested" BOOLEAN NOT NULL DEFAULT false,
    "bypass_reason" TEXT,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("approval_id")
);

-- CreateTable
CREATE TABLE "tournament_read_models" (
    "tournament_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "entry_fee" DECIMAL(15,2) NOT NULL,
    "max_players" INTEGER,
    "current_players" INTEGER,
    "status" TEXT NOT NULL,
    "stage" TEXT,
    "competition_wallet_id" UUID,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "season_duration" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_event_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tournament_read_models_pkey" PRIMARY KEY ("tournament_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_userId_key" ON "admin_users"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_command_id_key" ON "approval_requests"("command_id");

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admin_users"("adminId") ON DELETE CASCADE ON UPDATE CASCADE;
