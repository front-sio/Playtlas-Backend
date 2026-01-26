-- Payment Service Database Schema
-- Run: psql -d pool_game_payment -f backend/services/payment-service/schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Payment methods table
CREATE TABLE IF NOT EXISTS payment_methods (
  method_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('vodacom_mpesa', 'tigo_pesa', 'airtel_money', 'halopesa')),
  phone_number TEXT NOT NULL,
  account_name TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  verification_code TEXT,
  verified_at TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, phone_number, provider)
);

-- Deposits table (money coming in)
CREATE TABLE IF NOT EXISTS deposits (
  deposit_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  wallet_id UUID NOT NULL,
  method_id UUID,
  provider TEXT NOT NULL,
  amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'TZS',
  phone_number TEXT NOT NULL,
  reference_number TEXT UNIQUE NOT NULL,
  external_reference TEXT,
  provider_tid TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired', 'cancelled')),
  failure_reason TEXT,
  initiated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  expires_at TIMESTAMP,
  callback_data JSONB,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB,
  FOREIGN KEY (method_id) REFERENCES payment_methods(method_id) ON DELETE SET NULL
);

-- Withdrawals table (money going out)
CREATE TABLE IF NOT EXISTS withdrawals (
  withdrawal_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  wallet_id UUID NOT NULL,
  method_id UUID NOT NULL,
  provider TEXT NOT NULL,
  amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  fee DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_deducted DECIMAL(15,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TZS',
  phone_number TEXT NOT NULL,
  recipient_name TEXT,
  reference_number TEXT UNIQUE NOT NULL,
  external_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'reversed')),
  failure_reason TEXT,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  approved_by UUID,
  approved_at TIMESTAMP,
  initiated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  callback_data JSONB,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB,
  FOREIGN KEY (method_id) REFERENCES payment_methods(method_id)
);

-- Payment callbacks/webhooks log
CREATE TABLE IF NOT EXISTS payment_callbacks (
  callback_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider TEXT NOT NULL,
  reference_number TEXT NOT NULL,
  callback_type TEXT NOT NULL CHECK (callback_type IN ('deposit', 'withdrawal', 'verification')),
  payload JSONB NOT NULL,
  signature TEXT,
  is_valid BOOLEAN NOT NULL DEFAULT true,
  processed BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMP,
  error_message TEXT,
  ip_address TEXT,
  received_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Payment audit log (security-critical)
CREATE TABLE IF NOT EXISTS payment_audit_log (
  audit_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type TEXT NOT NULL CHECK (event_type IN ('deposit_initiated', 'deposit_completed', 'withdrawal_requested', 'withdrawal_approved', 'withdrawal_completed', 'withdrawal_rejected', 'method_added', 'method_verified', 'callback_received', 'fraud_detected', 'limit_exceeded')),
  user_id UUID,
  reference_id UUID,
  reference_type TEXT,
  amount DECIMAL(15,2),
  provider TEXT,
  status TEXT,
  details JSONB,
  ip_address TEXT,
  user_agent TEXT,
  admin_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Daily limits tracking
CREATE TABLE IF NOT EXISTS daily_limits (
  limit_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_deposits DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_withdrawals DECIMAL(15,2) NOT NULL DEFAULT 0,
  withdrawal_count INTEGER NOT NULL DEFAULT 0,
  deposit_count INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Fraud detection rules
CREATE TABLE IF NOT EXISTS fraud_rules (
  rule_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_name TEXT NOT NULL UNIQUE,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('velocity', 'amount', 'pattern', 'blacklist')),
  conditions JSONB NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('flag', 'block', 'review')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Flagged transactions
CREATE TABLE IF NOT EXISTS flagged_transactions (
  flag_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('deposit', 'withdrawal')),
  user_id UUID NOT NULL,
  rule_id UUID,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'investigating', 'resolved', 'confirmed_fraud')),
  reviewed_by UUID,
  reviewed_at TIMESTAMP,
  resolution TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (rule_id) REFERENCES fraud_rules(rule_id)
);

-- Tournament fee transactions (season entry fees)
CREATE TABLE IF NOT EXISTS tournament_fees (
  fee_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  wallet_id UUID NOT NULL,
  tournament_id UUID NOT NULL,
  season_id UUID NOT NULL,
  amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'TZS',
  fee DECIMAL(15,2) NOT NULL DEFAULT 0,
  reference_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  failure_reason TEXT,
  processed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Wallet transfer transactions (peer-to-peer transfers)
CREATE TABLE IF NOT EXISTS wallet_transfers (
  transfer_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_user_id UUID NOT NULL,
  from_wallet_id UUID NOT NULL,
  to_user_id UUID NOT NULL,
  to_wallet_id UUID NOT NULL,
  amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'TZS',
  fee DECIMAL(15,2) NOT NULL DEFAULT 0,
  description TEXT,
  reference_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  failure_reason TEXT,
  processed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_phone ON payment_methods(phone_number);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_reference ON deposits(reference_number);
CREATE INDEX IF NOT EXISTS idx_deposits_provider_tid ON deposits(provider_tid);
CREATE INDEX IF NOT EXISTS idx_deposits_created ON deposits(initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_reference ON withdrawals(reference_number);
CREATE INDEX IF NOT EXISTS idx_withdrawals_approval ON withdrawals(requires_approval, status) WHERE requires_approval = true;
CREATE INDEX IF NOT EXISTS idx_callbacks_reference ON payment_callbacks(reference_number);
CREATE INDEX IF NOT EXISTS idx_callbacks_processed ON payment_callbacks(processed);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON payment_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON payment_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_limits_user_date ON daily_limits(user_id, date);
CREATE INDEX IF NOT EXISTS idx_flagged_status ON flagged_transactions(status);
CREATE INDEX IF NOT EXISTS idx_flagged_severity ON flagged_transactions(severity);
CREATE INDEX IF NOT EXISTS idx_tournament_fees_user ON tournament_fees(user_id);
CREATE INDEX IF NOT EXISTS idx_tournament_fees_reference ON tournament_fees(reference_number);
CREATE INDEX IF NOT EXISTS idx_tournament_fees_tournament ON tournament_fees(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_fees_season ON tournament_fees(season_id);
CREATE INDEX IF NOT EXISTS idx_tournament_fees_created ON tournament_fees(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_from_user ON wallet_transfers(from_user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_to_user ON wallet_transfers(to_user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_reference ON wallet_transfers(reference_number);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_created ON wallet_transfers(created_at DESC);

-- Insert default fraud rules
INSERT INTO fraud_rules (rule_name, rule_type, conditions, action, is_active) VALUES
  ('high_velocity_deposits', 'velocity', '{"max_count": 5, "time_window_minutes": 60, "transaction_type": "deposit"}', 'flag', true),
  ('high_velocity_withdrawals', 'velocity', '{"max_count": 3, "time_window_minutes": 60, "transaction_type": "withdrawal"}', 'review', true),
  ('large_single_transaction', 'amount', '{"threshold": 2000000, "transaction_type": "withdrawal"}', 'review', true),
  ('suspicious_pattern_rapid_deposit_withdrawal', 'pattern', '{"deposit_withdrawal_time_gap_minutes": 15, "min_amount": 50000}', 'flag', true),
  ('midnight_transactions', 'pattern', '{"time_start": "00:00", "time_end": "05:00", "min_amount": 100000}', 'flag', true)
ON CONFLICT (rule_name) DO NOTHING;
