-- Migration: Add float adjustment tables to payment service
-- This migration adds tables for managing float adjustment requests with approval workflow

-- Create enum type for float request status if it doesn't exist
DO $$ BEGIN
    CREATE TYPE float_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create FloatAdjustmentRequest table
CREATE TABLE IF NOT EXISTS float_adjustment_requests (
    request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL,
    requested_by UUID NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('credit', 'debit')),
    amount DECIMAL(20, 2) NOT NULL CHECK (amount > 0),
    reason TEXT NOT NULL,
    status float_request_status DEFAULT 'PENDING',
    rejection_reason TEXT,
    processed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create FloatApproval table
CREATE TABLE IF NOT EXISTS float_approvals (
    approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES float_adjustment_requests(request_id) ON DELETE CASCADE,
    approved_by UUID NOT NULL,
    approver_role VARCHAR(50) NOT NULL,
    comments TEXT,
    approved_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (request_id, approved_by)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_float_adjustments_wallet ON float_adjustment_requests(wallet_id);
CREATE INDEX IF NOT EXISTS idx_float_adjustments_requested_by ON float_adjustment_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_float_adjustments_status ON float_adjustment_requests(status);
CREATE INDEX IF NOT EXISTS idx_float_approvals_request ON float_approvals(request_id);
CREATE INDEX IF NOT EXISTS idx_float_approvals_approved_by ON float_approvals(approved_by);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_float_adjustments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update updated_at
DROP TRIGGER IF EXISTS trigger_update_float_adjustments_updated_at ON float_adjustment_requests;
CREATE TRIGGER trigger_update_float_adjustments_updated_at
    BEFORE UPDATE ON float_adjustment_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_float_adjustments_updated_at();

-- Grant permissions (adjust as needed for your database user)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON float_adjustment_requests TO your_db_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON float_approvals TO your_db_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO your_db_user;
