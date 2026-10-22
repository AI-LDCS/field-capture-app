-- ---------- assignment progress ----------
ALTER TABLE assignments
  ADD COLUMN preflight       jsonb,
  ADD COLUMN quality         jsonb,
  ADD COLUMN review_reasons  jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN completed_at    timestamptz;
ALTER TABLE assignment_segments ADD COLUMN coverage numeric(5,4) NOT NULL DEFAULT 0;

-- ---------- recordings ----------
-- id is made on the phone (a UUID) so registering twice is harmless. user_id is kept here so every
-- worker query can be scoped to the owner without a join.
CREATE TABLE recordings (
  id              uuid PRIMARY KEY,
  assignment_id   uuid NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mime            text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'server_verified')),
  simulated       boolean NOT NULL DEFAULT false,   -- recorded with fake GPS or a fake camera (dev tools)
  started_at_ms   bigint NOT NULL,                  -- when the recorder really started (video t = 0)
  ended_at_ms     bigint,
  stop_reason     text,
  chunk_count     integer,
  gps_count       integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  -- the playable file built after verification
  assembly_state  text NOT NULL DEFAULT 'none' CHECK (assembly_state IN ('none', 'pending', 'running', 'done', 'failed')),
  assembly_error  text,
  file_key        text,
  file_bytes      bigint,
  file_sha256     text,
  file_mime       text,
  chunks_purged   boolean NOT NULL DEFAULT false
);
CREATE INDEX recordings_assignment_idx ON recordings (assignment_id);
CREATE INDEX recordings_user_idx ON recordings (user_id);
CREATE INDEX recordings_assembly_idx ON recordings (assembly_state) WHERE assembly_state IN ('pending', 'running');

CREATE TABLE recording_chunks (
  recording_id  uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  seq           integer NOT NULL CHECK (seq >= 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size          integer NOT NULL CHECK (size > 0),
  object_key    text NOT NULL,
  PRIMARY KEY (recording_id, seq)
);

CREATE TABLE gps_points (
  recording_id  uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  seq           integer NOT NULL CHECK (seq >= 0),
  t_ms          bigint NOT NULL,
  lat           double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng           double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  acc           double precision NOT NULL CHECK (acc >= 0),
  PRIMARY KEY (recording_id, seq)
);

-- which part of which recording covered which segment (lets the review page jump to a segment)
CREATE TABLE segment_evidence (
  assignment_segment_id  uuid NOT NULL REFERENCES assignment_segments(id) ON DELETE CASCADE,
  recording_id           uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  coverage               numeric(5,4) NOT NULL,
  first_t_ms             bigint,
  last_t_ms              bigint,
  PRIMARY KEY (assignment_segment_id, recording_id)
);

-- a finished recording is evidence: its identity and owner never change
CREATE FUNCTION recordings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.assignment_id <> OLD.assignment_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'a recording keeps its id, assignment and owner';
  END IF;
  IF OLD.status = 'server_verified' AND (
       NEW.status <> 'server_verified' OR NEW.chunk_count IS DISTINCT FROM OLD.chunk_count
       OR NEW.gps_count IS DISTINCT FROM OLD.gps_count OR NEW.started_at_ms <> OLD.started_at_ms
       OR NEW.mime <> OLD.mime OR NEW.simulated <> OLD.simulated) THEN
    RAISE EXCEPTION 'a verified recording is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recordings_guard BEFORE UPDATE ON recordings FOR EACH ROW EXECUTE FUNCTION recordings_guard();

-- data of a verified recording cannot be added to or changed
CREATE FUNCTION recording_data_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r_status text; rid uuid;
BEGIN
  rid := CASE WHEN TG_OP = 'DELETE' THEN OLD.recording_id ELSE NEW.recording_id END;
  SELECT status INTO r_status FROM recordings WHERE id = rid;
  IF r_status = 'server_verified' AND TG_TABLE_NAME = 'gps_points' THEN
    RAISE EXCEPTION 'gps points of a verified recording are immutable';
  END IF;
  IF r_status = 'server_verified' AND TG_OP <> 'UPDATE' AND TG_TABLE_NAME = 'recording_chunks' THEN
    RAISE EXCEPTION 'chunks of a verified recording are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER gps_points_guard BEFORE INSERT OR UPDATE OR DELETE ON gps_points FOR EACH ROW EXECUTE FUNCTION recording_data_guard();
CREATE TRIGGER recording_chunks_guard BEFORE INSERT OR DELETE ON recording_chunks FOR EACH ROW EXECUTE FUNCTION recording_data_guard();
