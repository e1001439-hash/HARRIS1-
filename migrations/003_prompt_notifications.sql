ALTER TABLE notifications ADD COLUMN phase text NOT NULL DEFAULT 'analysis' CHECK (phase IN ('receipt', 'analysis'));
ALTER TABLE notifications DROP CONSTRAINT notifications_task_id_key;
ALTER TABLE notifications ADD CONSTRAINT notifications_task_phase_key UNIQUE (task_id, phase);
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'unknown', 'superseded'));
CREATE INDEX events_user_received_idx ON events(user_id, received_at, sequence);
ALTER TABLE events ADD COLUMN manual_handoff boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN handoff_revision integer NOT NULL DEFAULT 0;
