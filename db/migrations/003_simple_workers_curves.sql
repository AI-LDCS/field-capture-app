-- Curved segments keep the points the admin placed (control); the stored geometry is the smooth line through them.
ALTER TABLE route_segments ADD COLUMN control jsonb;
ALTER TABLE route_segments ADD CONSTRAINT route_segments_control_is_array
  CHECK (control IS NULL OR (jsonb_typeof(control) = 'array' AND jsonb_array_length(control) >= 2));

-- Workers are simple: username, display name, and a password only an admin can set. No notes, no forced change.
ALTER TABLE assignments DROP COLUMN note;
ALTER TABLE users DROP COLUMN must_change_password;
