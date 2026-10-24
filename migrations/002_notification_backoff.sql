ALTER TABLE notifications ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX notifications_due_idx ON notifications(status, next_attempt_at);
