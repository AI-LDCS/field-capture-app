CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------- users & sessions ----------
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username              text NOT NULL CHECK (username ~ '^[a-z0-9._-]{3,32}$'),
  display_name          text NOT NULL DEFAULT '',
  password_hash         text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('admin', 'worker')),
  active                boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT false,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (username);

-- id is the SHA-256 of the cookie token, so a database leak does not leak live sessions
CREATE TABLE sessions (
  id            text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE login_attempts (
  id        bigserial PRIMARY KEY,
  username  text NOT NULL,
  ip        text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_user_idx ON login_attempts (username, at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at);

-- ---------- routes (container) and immutable versions ----------
CREATE TABLE routes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE route_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id      uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  version       integer NOT NULL CHECK (version >= 1),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  UNIQUE (route_id, version)
);
-- at most one draft and one published version per route
CREATE UNIQUE INDEX route_versions_one_draft ON route_versions (route_id) WHERE status = 'draft';
CREATE UNIQUE INDEX route_versions_one_published ON route_versions (route_id) WHERE status = 'published';

CREATE TABLE route_segments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_version_id    uuid NOT NULL REFERENCES route_versions(id) ON DELETE CASCADE,
  ord                 integer NOT NULL CHECK (ord >= 0),
  name                text NOT NULL DEFAULT '',
  required            boolean NOT NULL,
  geom                geometry(LineString, 4326) NOT NULL,
  min_coverage_ratio  numeric(4,3) NOT NULL DEFAULT 0.900 CHECK (min_coverage_ratio BETWEEN 0.5 AND 1),
  UNIQUE (route_version_id, ord)
);
CREATE INDEX route_segments_geom_idx ON route_segments USING gist (geom);

-- Published and archived versions never change. Enforced here, not only in the API.
CREATE FUNCTION route_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only draft route versions can be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.route_id <> OLD.route_id OR NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'route version identity is immutable once published';
    END IF;
    IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
      RAISE EXCEPTION 'archived route versions cannot be reopened';
    END IF;
    IF OLD.status = 'published' AND NEW.status NOT IN ('published', 'archived') THEN
      RAISE EXCEPTION 'published route versions cannot go back to draft';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER route_versions_guard BEFORE UPDATE OR DELETE ON route_versions
  FOR EACH ROW EXECUTE FUNCTION route_versions_guard();

CREATE FUNCTION route_segments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_id := OLD.route_version_id; ELSE v_id := NEW.route_version_id; END IF;
  SELECT status INTO v_status FROM route_versions WHERE id = v_id;
  -- a missing parent means the version itself is being deleted (cascade); allow it
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'segments of a % route version are immutable', v_status;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.route_version_id <> OLD.route_version_id THEN
    RAISE EXCEPTION 'segments cannot move between versions';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER route_segments_guard BEFORE INSERT OR UPDATE OR DELETE ON route_segments
  FOR EACH ROW EXECUTE FUNCTION route_segments_guard();

-- ---------- assignments ----------
CREATE TABLE assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_version_id  uuid NOT NULL REFERENCES route_versions(id) ON DELETE RESTRICT,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by       uuid REFERENCES users(id),
  status            text NOT NULL DEFAULT 'assigned'
                    CHECK (status IN ('assigned', 'in_progress', 'pending_sync', 'completed', 'needs_review')),
  note              text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignments_user_idx ON assignments (user_id, created_at DESC);

CREATE FUNCTION assignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; u_role text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status FROM route_versions WHERE id = NEW.route_version_id;
    IF v_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'only published route versions can be assigned';
    END IF;
    SELECT role INTO u_role FROM users WHERE id = NEW.user_id;
    IF u_role IS DISTINCT FROM 'worker' THEN
      RAISE EXCEPTION 'assignments go to field workers only';
    END IF;
  ELSIF NEW.route_version_id <> OLD.route_version_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'an assignment keeps its route version and worker';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assignments_guard BEFORE INSERT OR UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION assignments_guard();

CREATE TABLE assignment_segments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id      uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  route_segment_id   uuid NOT NULL REFERENCES route_segments(id) ON DELETE RESTRICT,
  ord                integer NOT NULL,
  required           boolean NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
  skip_reason        text,
  completed_at       timestamptz,
  UNIQUE (assignment_id, route_segment_id),
  UNIQUE (assignment_id, ord),
  -- a required segment can never be skipped
  CONSTRAINT skipped_only_if_optional CHECK (NOT (status = 'skipped' AND required))
);

-- ---------- audit ----------
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  details      jsonb,
  ip           text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
