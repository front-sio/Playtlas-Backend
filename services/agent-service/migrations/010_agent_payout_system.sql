-- Agent Payout System Database Schema
-- Implements hybrid compensation: Base Pay + Revenue Share + Bonuses

BEGIN;

-- Agent Shifts/Attendance tracking
CREATE TABLE IF NOT EXISTS agent_shifts (
  shift_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  
  -- Shift timing
  shift_date DATE NOT NULL,
  start_time TIME DEFAULT '11:00:00',
  end_time TIME DEFAULT '23:00:00',
  
  -- Status tracking
  status VARCHAR(20) DEFAULT 'SCHEDULED', -- SCHEDULED, ACTIVE, COMPLETED, MISSED, CANCELLED
  actual_start_time TIMESTAMP,
  actual_end_time TIMESTAMP,
  
  -- Compensation
  base_pay_amount DECIMAL(10,2) DEFAULT 1500.00,
  
  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(club_id, agent_id, shift_date)
);

CREATE INDEX IF NOT EXISTS idx_agent_shifts_club_date ON agent_shifts(club_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_agent_shifts_agent ON agent_shifts(agent_id, shift_date);

-- Club revenue aggregation (daily)
CREATE TABLE IF NOT EXISTS club_revenue_daily (
  revenue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL,
  revenue_date DATE NOT NULL,
  
  -- Revenue breakdown
  total_entry_fees DECIMAL(12,2) DEFAULT 0,
  total_platform_fees DECIMAL(12,2) DEFAULT 0,
  
  -- Tournament stats
  total_seasons INTEGER DEFAULT 0,
  total_matches INTEGER DEFAULT 0,
  completed_matches INTEGER DEFAULT 0,
  
  -- Agent pool calculation
  agent_share_percent DECIMAL(5,4) DEFAULT 0.20, -- 20% default
  agent_pool_amount DECIMAL(12,2) DEFAULT 0,
  
  -- Status
  status VARCHAR(20) DEFAULT 'DRAFT', -- DRAFT, FINALIZED
  
  -- Audit
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  finalized_at TIMESTAMP,
  finalized_by UUID,
  
  UNIQUE(club_id, revenue_date)
);

CREATE INDEX IF NOT EXISTS idx_club_revenue_club_date ON club_revenue_daily(club_id, revenue_date);

-- Agent earnings (daily calculation)
CREATE TABLE IF NOT EXISTS agent_earnings_daily (
  earnings_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  earnings_date DATE NOT NULL,
  
  -- Compensation breakdown
  base_pay_amount DECIMAL(10,2) DEFAULT 0,
  revenue_share_amount DECIMAL(10,2) DEFAULT 0,
  bonus_amount DECIMAL(10,2) DEFAULT 0,
  total_amount DECIMAL(10,2) DEFAULT 0,
  
  -- Contribution metrics
  matches_completed INTEGER DEFAULT 0,
  uptime_minutes INTEGER DEFAULT 0,
  uptime_percentage DECIMAL(5,2) DEFAULT 0,
  
  -- Weight calculation
  match_weight DECIMAL(8,4) DEFAULT 0,
  uptime_weight DECIMAL(8,4) DEFAULT 0,
  total_weight DECIMAL(8,4) DEFAULT 0,
  weight_percentage DECIMAL(5,4) DEFAULT 0,
  
  -- Computation metadata
  computed_from JSONB DEFAULT '{}', -- Store computation details
  
  -- Status
  status VARCHAR(20) DEFAULT 'DRAFT', -- DRAFT, FINALIZED, PAID
  
  -- Audit trail
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  finalized_at TIMESTAMP,
  finalized_by UUID,
  paid_at TIMESTAMP,
  paid_by UUID,
  
  UNIQUE(club_id, agent_id, earnings_date)
);

CREATE INDEX IF NOT EXISTS idx_agent_earnings_club_date ON agent_earnings_daily(club_id, earnings_date);
CREATE INDEX IF NOT EXISTS idx_agent_earnings_agent ON agent_earnings_daily(agent_id, earnings_date);
CREATE INDEX IF NOT EXISTS idx_agent_earnings_status ON agent_earnings_daily(status, earnings_date);

-- Payout transactions
CREATE TABLE IF NOT EXISTS payout_transactions (
  transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  
  -- Payout period
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  
  -- Amount and method
  amount DECIMAL(12,2) NOT NULL,
  method VARCHAR(20) DEFAULT 'WALLET', -- WALLET, MOBILE_MONEY, BANK, CASH
  
  -- Payment details
  reference_id VARCHAR(100),
  recipient_details JSONB DEFAULT '{}', -- Phone, account, etc.
  
  -- Status tracking
  status VARCHAR(20) DEFAULT 'INITIATED', -- INITIATED, SUCCESS, FAILED, CANCELLED
  
  -- Audit
  initiated_by UUID,
  processed_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP,
  
  -- Failure handling
  failure_reason TEXT,
  retry_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_payout_transactions_agent ON payout_transactions(agent_id, period_start);
CREATE INDEX IF NOT EXISTS idx_payout_transactions_club ON payout_transactions(club_id, period_start);
CREATE INDEX IF NOT EXISTS idx_payout_transactions_status ON payout_transactions(status, created_at);

-- Agent contribution logs (for audit trail)
CREATE TABLE IF NOT EXISTS agent_contribution_logs (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  contribution_date DATE NOT NULL,
  
  -- Match contribution
  match_id UUID,
  device_id UUID,
  match_started_at TIMESTAMP,
  match_completed_at TIMESTAMP,
  match_duration_seconds INTEGER,
  
  -- Revenue attribution
  match_entry_fee DECIMAL(10,2) DEFAULT 0,
  match_platform_fee DECIMAL(10,2) DEFAULT 0,
  
  -- Weight calculation
  contribution_weight DECIMAL(8,4) DEFAULT 1.0,
  contribution_type VARCHAR(20) DEFAULT 'MATCH', -- MATCH, UPTIME, BONUS
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_contribution_logs_agent_date ON agent_contribution_logs(agent_id, contribution_date);
CREATE INDEX IF NOT EXISTS idx_agent_contribution_logs_club_date ON agent_contribution_logs(club_id, contribution_date);
CREATE INDEX IF NOT EXISTS idx_agent_contribution_logs_match ON agent_contribution_logs(match_id);

-- Club payout configuration
CREATE TABLE IF NOT EXISTS club_payout_configs (
  config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL UNIQUE,
  
  -- Base pay settings
  base_pay_amount DECIMAL(10,2) DEFAULT 1500.00,
  base_pay_currency VARCHAR(3) DEFAULT 'TSH',
  
  -- Revenue share settings
  agent_share_percent DECIMAL(5,4) DEFAULT 0.20, -- 20%
  
  -- Weight calculation settings
  weight_by_matches BOOLEAN DEFAULT TRUE,
  weight_by_uptime BOOLEAN DEFAULT FALSE,
  match_weight_percent DECIMAL(3,2) DEFAULT 1.00, -- 100% matches if uptime disabled
  uptime_weight_percent DECIMAL(3,2) DEFAULT 0.00, -- 0% uptime if disabled
  
  -- Bonus settings
  uptime_bonus_enabled BOOLEAN DEFAULT TRUE,
  uptime_bonus_threshold DECIMAL(3,2) DEFAULT 0.95, -- 95%
  uptime_bonus_amount DECIMAL(10,2) DEFAULT 500.00,
  
  attendance_bonus_enabled BOOLEAN DEFAULT TRUE,
  attendance_bonus_amount DECIMAL(10,2) DEFAULT 300.00,
  
  quality_bonus_enabled BOOLEAN DEFAULT FALSE,
  quality_bonus_amount DECIMAL(10,2) DEFAULT 200.00,
  
  -- Payout settings
  payout_frequency VARCHAR(20) DEFAULT 'DAILY', -- DAILY, WEEKLY, MONTHLY
  auto_payout_enabled BOOLEAN DEFAULT FALSE,
  min_payout_amount DECIMAL(10,2) DEFAULT 100.00,
  
  -- Audit
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by UUID
);

-- Earnings audit log
CREATE TABLE IF NOT EXISTS earnings_audit_log (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL,
  agent_id UUID,
  earnings_date DATE,
  
  -- Action details
  action VARCHAR(50) NOT NULL, -- COMPUTED, FINALIZED, PAID, RECALCULATED, CANCELLED
  triggered_by UUID NOT NULL,
  
  -- Data snapshot
  before_data JSONB,
  after_data JSONB,
  
  -- Metadata
  reason TEXT,
  ip_address INET,
  user_agent TEXT,
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_earnings_audit_club_date ON earnings_audit_log(club_id, earnings_date);
CREATE INDEX IF NOT EXISTS idx_earnings_audit_agent ON earnings_audit_log(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_earnings_audit_action ON earnings_audit_log(action, created_at);

COMMIT;