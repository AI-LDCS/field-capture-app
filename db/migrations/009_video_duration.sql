-- ---------- length of the finished video ----------
-- The GPS export gives each point a video time computed from the phone's clock. Reading the real length
-- of the assembled file lets the export say when the two clocks disagree. NULL = not read (recordings built
-- before this migration, a failed read, or a file without a duration).
ALTER TABLE recordings ADD COLUMN video_duration_ms integer;
