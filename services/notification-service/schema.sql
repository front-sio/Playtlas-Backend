-- Notification Service Database Schema
-- Run: psql -d pool_game_notification -f backend/services/notification-service/schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS notifications (
  notification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('system', 'tournament', 'match', 'payment', 'achievement')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB,
  channel TEXT NOT NULL CHECK (channel IN ('push', 'email', 'sms', 'in_app')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'read')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMP,
  sent_at TIMESTAMP,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_templates (
  template_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  template TEXT NOT NULL,
  variables JSONB,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  preference_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE,
  email_enabled BOOLEAN NOT NULL DEFAULT true,
  sms_enabled BOOLEAN NOT NULL DEFAULT true,
  push_enabled BOOLEAN NOT NULL DEFAULT true,
  tournament_updates BOOLEAN NOT NULL DEFAULT true,
  match_reminders BOOLEAN NOT NULL DEFAULT true,
  payment_alerts BOOLEAN NOT NULL DEFAULT true,
  marketing_emails BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_notification_templates_name ON notification_templates(name);
CREATE INDEX IF NOT EXISTS idx_notification_templates_active ON notification_templates(is_active);

-- Insert default notification templates
INSERT INTO notification_templates (name, type, channel, subject, template, variables) VALUES
  ('welcome_email', 'system', 'email', 'Welcome to Pool Table Game!', '<h1>Welcome {{username}}!</h1><p>Your account has been created successfully.</p>', '["username"]'),
  ('tournament_started', 'tournament', 'push', 'Tournament Started', 'Tournament {{tournamentName}} has started! Good luck!', '["tournamentName"]'),
  ('match_reminder', 'match', 'sms', 'Match Reminder', 'Your match starts in {{minutes}} minutes! Get ready!', '["minutes"]'),
  ('prize_won', 'payment', 'email', 'Congratulations! You Won!', '<h1>Congratulations!</h1><p>You won {{amount}} TZS in {{tournamentName}}!</p>', '["amount", "tournamentName"]'),
  ('payment_received', 'payment', 'sms', 'Payment Confirmed', 'Payment of {{amount}} TZS has been received successfully.', '["amount"]')
ON CONFLICT (name) DO NOTHING;
