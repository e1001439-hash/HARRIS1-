CREATE TABLE sessions (
  user_id text PRIMARY KEY,
  customer_number bigserial NOT NULL UNIQUE,
  customer_ref text GENERATED ALWAYS AS ('C' || lpad(customer_number::text, greatest(6, length(customer_number::text)), '0')) STORED UNIQUE,
  handoff boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id text PRIMARY KEY,
  sequence bigserial NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES sessions(user_id),
  payload jsonb,
  received_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  send_started timestamptz,
  outcome jsonb,
  delivery text CHECK (delivery IN ('sent', 'failed', 'unknown', 'not_sent')),
  completed_at timestamptz,
  text_removed_at timestamptz
);
CREATE INDEX events_pending_idx ON events(status, sequence);
CREATE INDEX events_user_order_idx ON events(user_id, sequence);

CREATE TABLE tasks (
  task_number bigserial PRIMARY KEY,
  id text GENERATED ALWAYS AS ('T' || lpad(task_number::text, greatest(6, length(task_number::text)), '0')) STORED UNIQUE,
  event_id text UNIQUE REFERENCES events(id) ON DELETE SET NULL,
  user_id text NOT NULL REFERENCES sessions(user_id),
  status text NOT NULL CHECK (status IN ('open', 'done')),
  booking_status text NOT NULL CHECK (booking_status IN ('none', 'requested', 'self_reported', 'owner_confirmed')),
  confirmation_source text CHECK (confirmation_source = 'owner_confirmation'),
  summary text NOT NULL,
  next_action text NOT NULL,
  service text,
  requested_time text,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  text_removed_at timestamptz
);
CREATE INDEX tasks_open_idx ON tasks(status, created_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  task_id text NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  text text NOT NULL,
  retry_key uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'unknown')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  text_removed_at timestamptz
);
CREATE INDEX notifications_pending_idx ON notifications(status, created_at);

CREATE TABLE feedback (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  text_removed_at timestamptz
);
