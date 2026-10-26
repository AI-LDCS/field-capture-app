-- A deleted worker keeps their row, so their assignments and recordings stay intact and still say who did them.
-- The row can no longer log in or be managed, and the username becomes free for a new worker.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
DROP INDEX users_username_key;
CREATE UNIQUE INDEX users_username_key ON users (username) WHERE deleted_at IS NULL;
