-- Keep only an event identifier, without a foreign key: conversation retention
-- must not reset a customer's introduction after its source event is removed.
ALTER TABLE sessions ADD COLUMN assistant_intro_event_id text;
