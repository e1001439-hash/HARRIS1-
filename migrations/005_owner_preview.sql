ALTER TABLE events ADD COLUMN owner_preview_started_at timestamptz;
CREATE INDEX events_owner_preview_budget_idx ON events(user_id, owner_preview_started_at) WHERE owner_preview_started_at IS NOT NULL;
