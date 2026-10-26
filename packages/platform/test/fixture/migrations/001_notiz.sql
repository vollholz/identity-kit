-- Beispielmodul Notiz (Spezifikation 5.7): Blatt-Typ unter org, mit Klassifizierung, Version und Verlauf.

CREATE TABLE probe.notiz (
  tenant_id       uuid NOT NULL REFERENCES probe.tenant (id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  label           text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  beginn          time,
  ende            time,
  classification  smallint NOT NULL DEFAULT 0 CHECK (classification BETWEEN 0 AND 2),
  version         int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid DEFAULT app.principal_id(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid DEFAULT app.principal_id(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((beginn IS NULL) = (ende IS NULL))
);
CREATE UNIQUE INDEX notiz_label ON probe.notiz (tenant_id, lower(label));
CREATE INDEX notiz_list ON probe.notiz (tenant_id, label, id);

-- Verlauf: nur anhängen (Trigger schreibt, die Laufzeit darf lesen und einfügen, nie ändern oder löschen)
CREATE TABLE probe.notiz_version (
  tenant_id       uuid NOT NULL REFERENCES probe.tenant (id) ON DELETE CASCADE,
  notiz_id   uuid NOT NULL,
  version         int NOT NULL,
  action          text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  label           text NOT NULL,
  beginn          time,
  ende            time,
  classification  smallint NOT NULL,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  changed_by      uuid,
  PRIMARY KEY (tenant_id, notiz_id, version)
);

CREATE FUNCTION probe.notiz_history() RETURNS trigger LANGUAGE plpgsql SET search_path = probe, pg_temp AS $$
DECLARE r probe.notiz;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  INSERT INTO probe.notiz_version (tenant_id, notiz_id, version, action, label, beginn, ende, classification, changed_by)
  VALUES (r.tenant_id, r.id, CASE WHEN TG_OP = 'DELETE' THEN r.version + 1 ELSE r.version END,
          CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
          r.label, r.beginn, r.ende, r.classification, app.principal_id());
  RETURN NULL;
END $$;
CREATE TRIGGER notiz_history AFTER INSERT OR UPDATE OR DELETE ON probe.notiz
  FOR EACH ROW EXECUTE FUNCTION probe.notiz_history();
REVOKE ALL ON FUNCTION probe.notiz_history() FROM PUBLIC;

-- Version und Änderungszeit setzt die Datenbank (ETag/If-Match prüft die API über version)
CREATE FUNCTION probe.notiz_touch() RETURNS trigger LANGUAGE plpgsql SET search_path = probe, pg_temp AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  NEW.updated_by := app.principal_id();
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END $$;
CREATE TRIGGER notiz_touch BEFORE UPDATE ON probe.notiz FOR EACH ROW EXECUTE FUNCTION probe.notiz_touch();
REVOKE ALL ON FUNCTION probe.notiz_touch() FROM PUBLIC;

SELECT app.secure_tenant_tables();
REVOKE UPDATE, DELETE ON probe.notiz_version FROM probe_app;

-- Lesesicht (identity-kit 7.6): Klassifizierung bis zur Freigabestufe, Rolle an org oder Tupel an der Notiz
CREATE POLICY notiz_read ON probe.notiz AS RESTRICTIVE FOR SELECT TO probe_app USING (
  classification <= app.clearance() AND (app.read_all() OR app.has_tuple('notiz', id, app.read_relations())));
CREATE POLICY notiz_insert ON probe.notiz AS RESTRICTIVE FOR INSERT TO probe_app WITH CHECK (
  classification <= app.clearance() AND app.write_all());
CREATE POLICY notiz_update ON probe.notiz AS RESTRICTIVE FOR UPDATE TO probe_app
  USING (classification <= app.clearance() AND (app.write_all() OR app.has_tuple('notiz', id, app.write_relations())))
  WITH CHECK (classification <= app.clearance() AND (app.write_all() OR app.has_tuple('notiz', id, app.write_relations())));
CREATE POLICY notiz_delete ON probe.notiz AS RESTRICTIVE FOR DELETE TO probe_app USING (
  classification <= app.clearance() AND (app.write_all() OR app.has_tuple('notiz', id, app.write_relations())));

CREATE POLICY notiz_version_read ON probe.notiz_version AS RESTRICTIVE FOR SELECT TO probe_app USING (
  classification <= app.clearance() AND (app.read_all() OR app.has_tuple('notiz', notiz_id, app.read_relations())));
