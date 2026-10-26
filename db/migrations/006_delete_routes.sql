-- A deleted route is hidden, not erased: its versions stay, so assignments and recordings made on it keep their route.
ALTER TABLE routes ADD COLUMN deleted_at timestamptz;
