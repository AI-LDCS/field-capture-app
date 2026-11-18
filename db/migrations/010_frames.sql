-- ---------- sampled, anonymized frames ----------
-- Besides (or instead of) the anonymized video, the GPU worker can cut the finished video into still images:
-- the sharpest frame every SAMPLE_STEP_M metres walked, anonymized, with GPS. This adds the queue for that job
-- (a copy of the anon_* columns, so the two jobs never disturb each other) and one row per image.
--   frames_state  none     no job (not built yet, or an older recording nobody queued)
--                 pending  waiting for the worker; a recording waits until the earlier ones of its assignment are done,
--                          because the distance counter and frame numbers carry on from one recording to the next
--                 running  claimed; frames_lease_id says by whom, frames_lease_until until when
--                 done     frames_count images are stored
--                 failed   gave up after frames_attempts tries (an admin can queue it again)
--   frames_carry  the counter state at the end of this recording, for the next one: {cumM, nextFrame, lastLat, lastLng}

-- what the images are for. 'training': the worker who walked can download them (for labelling).
-- 'inference': only admins can, and GPS and IDs are written into each image. Chosen when the assignment is made.
ALTER TABLE assignments
  ADD COLUMN purpose text NOT NULL DEFAULT 'inference' CHECK (purpose IN ('training', 'inference'));

ALTER TABLE recordings
  ADD COLUMN frames_state       text NOT NULL DEFAULT 'none' CHECK (frames_state IN ('none', 'pending', 'running', 'done', 'failed')),
  ADD COLUMN frames_error       text,
  ADD COLUMN frames_attempts    integer NOT NULL DEFAULT 0,
  ADD COLUMN frames_lease_id    uuid,
  ADD COLUMN frames_lease_until timestamptz,
  ADD COLUMN frames_count       integer,
  ADD COLUMN frames_step_m      numeric(6,2),
  ADD COLUMN frames_mode        text,
  ADD COLUMN frames_carry       jsonb,
  ADD COLUMN frames_at          timestamptz;
CREATE INDEX recordings_frames_idx ON recordings (frames_state) WHERE frames_state IN ('pending', 'running');

CREATE TABLE recording_frames (
  recording_id   uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  frame          integer NOT NULL,            -- counted across the whole assignment, in walking order
  bin            integer NOT NULL,            -- which step of the distance counter
  file_name      text NOT NULL,
  file_key       text NOT NULL,
  file_bytes     bigint NOT NULL,
  file_sha256    text NOT NULL,
  taken_at       timestamptz NOT NULL,
  video_time_s   double precision NOT NULL,
  walked_start_m real NOT NULL,
  walked_end_m   real NOT NULL,
  latitude       double precision NOT NULL,   -- the smoothed track, not the raw fix
  longitude      double precision NOT NULL,
  accuracy_m     real NOT NULL,
  heading_deg    real,                        -- NULL when standing still
  sharpness      real NOT NULL,
  low_sharpness  boolean NOT NULL DEFAULT false,
  time_uncertain boolean NOT NULL DEFAULT false,
  after_gap      boolean NOT NULL DEFAULT false,
  gap_m          real,
  PRIMARY KEY (recording_id, frame)
);
