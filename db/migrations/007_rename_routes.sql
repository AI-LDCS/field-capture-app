-- A route's name is a label, so an admin may rename a route everywhere. Everything else about a
-- published or archived version stays frozen, including its segments (route_segments_guard).
CREATE OR REPLACE FUNCTION route_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
