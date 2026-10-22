-- The name belongs to a version. Renaming a draft must never change a published version
-- or the assignments that point at it. routes.name stays as "current name" for lists.
ALTER TABLE route_versions ADD COLUMN name text;
UPDATE route_versions v SET name = r.name FROM routes r WHERE r.id = v.route_id;
ALTER TABLE route_versions ALTER COLUMN name SET NOT NULL;
ALTER TABLE route_versions ADD CONSTRAINT route_versions_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 120);

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
    IF NEW.name <> OLD.name THEN
      RAISE EXCEPTION 'route version name is immutable once published';
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
