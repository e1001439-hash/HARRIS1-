CREATE TABLE pairing_windows (
  window_number bigserial PRIMARY KEY,
  ref text GENERATED ALWAYS AS ('P' || lpad(window_number::text, greatest(6, length(window_number::text)), '0')) STORED UNIQUE,
  scope text NOT NULL,
  owner_id text NOT NULL,
  source_event_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'confirmed', 'cancelled', 'expired')),
  code_hash text UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  candidate_user_id text CHECK (candidate_user_id <> owner_id),
  candidate_event_id text,
  candidate_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '5 minutes',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  UNIQUE (scope, owner_id, source_event_id),
  UNIQUE (scope, owner_id, candidate_event_id),
  CHECK (
    (status = 'open' AND code_hash IS NOT NULL AND candidate_user_id IS NULL AND candidate_at IS NULL AND closed_at IS NULL)
    OR (status = 'pending' AND code_hash IS NULL AND candidate_user_id IS NOT NULL AND candidate_event_id IS NOT NULL AND candidate_at IS NOT NULL AND closed_at IS NULL)
    OR (status IN ('confirmed', 'cancelled', 'expired') AND code_hash IS NULL AND candidate_user_id IS NULL AND candidate_at IS NULL AND closed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX pairing_windows_active_context_idx ON pairing_windows(scope, owner_id) WHERE status IN ('open', 'pending');
CREATE INDEX pairing_windows_cleanup_idx ON pairing_windows(status, expires_at, closed_at);

CREATE TABLE tester_grants (
  scope text NOT NULL,
  owner_id text NOT NULL,
  user_id text NOT NULL CHECK (user_id <> owner_id),
  ref text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, owner_id, user_id),
  UNIQUE (scope, owner_id, ref)
);
