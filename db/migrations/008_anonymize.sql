-- ---------- anonymized copy of a recording ----------
-- A separate worker (the GPU machine) claims an assembled recording, blurs or masks faces and plates,
-- and uploads the result. The original stays; this adds a second file next to it.
--   anon_state    none     no job (not assembled yet)
--                 pending  waiting for the worker
--                 running  claimed; anon_lease_id says by whom, anon_lease_until until when
--                 done     anon_key points at the finished file
--                 failed   gave up after anon_attempts tries (an admin can queue it again)
ALTER TABLE recordings
  ADD COLUMN anon_state       text NOT NULL DEFAULT 'none' CHECK (anon_state IN ('none', 'pending', 'running', 'done', 'failed')),
  ADD COLUMN anon_error       text,
  ADD COLUMN anon_attempts    integer NOT NULL DEFAULT 0,
  ADD COLUMN anon_lease_id    uuid,
  ADD COLUMN anon_lease_until timestamptz,
  ADD COLUMN anon_key         text,
  ADD COLUMN anon_bytes       bigint,
  ADD COLUMN anon_sha256      text,
  ADD COLUMN anon_mode        text,
  ADD COLUMN anonymized_at    timestamptz;
CREATE INDEX recordings_anon_idx ON recordings (anon_state) WHERE anon_state IN ('pending', 'running');

-- recordings that were already built before this migration are queued too
UPDATE recordings SET anon_state = 'pending' WHERE assembly_state = 'done';
