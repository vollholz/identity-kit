-- iam_019 Eigene Rollen der Organisation (Kit 5.0; docs/authz-offene-punkte.md O17): Rollen, die eine Organisation zur
-- Laufzeit aus den Rechten des Modells zusammenstellt. Das Modell der App (Rechte, Typen, Rollen) bleibt im Code; eine
-- eigene Rolle ergänzt es nur (Schlüssel immer mit «c-», nie gleich einer Rolle des Modells).
--
-- - authz_role: Daten je Organisation (tenant_id zuerst im Schlüssel, RLS ENABLE + FORCE über
--   app.secure_tenant_tables, Policy owner_tenant für die Besitzer-Rolle). Jede Änderung erhöht acl_version: die
--   Entscheidung aller Instanzen lädt das Modell der Organisation neu.
-- - Welche Rechte erlaubt sind (nur Rechte des Modells, keine nur von org-admin), prüft das Paket; die Datenbank kennt
--   das Modell nicht. Sie sichert, dass ein Tupel mit eigener Rolle nur an einem ihrer Orte hängt und dass eine Rolle
--   nicht gelöscht oder von einem Ort entfernt wird, solange sie dort vergeben ist.
-- - Die CHECKs von authz_tuple (syncModelChecks) lassen Relationen «c-…» zu, wenn das Modell eigene Rollen erlaubt.

CREATE TABLE {{schema}}.authz_role (
  tenant_id   uuid NOT NULL REFERENCES {{schema}}.tenant (id),
  key         text NOT NULL,
  label       text NOT NULL,
  description text NOT NULL DEFAULT '',
  permissions text[] NOT NULL,
  places      text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,                   -- principal.id; leer bei Plattform-Administration
  PRIMARY KEY (tenant_id, key),
  CONSTRAINT authz_role_key_check CHECK (key ~ '^c-[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  CONSTRAINT authz_role_label_check CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  CONSTRAINT authz_role_description_check CHECK (length(description) <= 500),
  CONSTRAINT authz_role_permissions_check CHECK (cardinality(permissions) BETWEEN 1 AND 200),
  CONSTRAINT authz_role_places_check CHECK (cardinality(places) BETWEEN 1 AND 50)
);
CREATE UNIQUE INDEX authz_role_label ON {{schema}}.authz_role (tenant_id, lower(btrim(label)));
CREATE TRIGGER authz_role_acl_version AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.authz_role
  FOR EACH ROW EXECUTE FUNCTION app.bump_acl_version();

-- Schlüssel bleibt; löschen bzw. Orte entfernen nur, wo die Rolle nicht (mehr) vergeben ist
CREATE FUNCTION app.custom_role_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'Schlüssel der Rolle % lässt sich nicht ändern', OLD.key USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM {{schema}}.authz_tuple t WHERE t.tenant_id = OLD.tenant_id AND t.relation = OLD.key
             AND (TG_OP = 'DELETE' OR NOT t.object_type = ANY (NEW.places))) THEN
    RAISE EXCEPTION 'Rolle % ist noch vergeben', OLD.key USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER authz_role_guard BEFORE UPDATE OR DELETE ON {{schema}}.authz_role
  FOR EACH ROW EXECUTE FUNCTION app.custom_role_guard();

-- Tupel mit eigener Rolle nur an ihren Orten (im selben Mandanten). FOR SHARE sperrt die Zeile der Rolle bis zum Ende
-- der Transaktion: ein gleichzeitiges Löschen oder Ändern der Orte wartet und sieht danach das Tupel (sonst bliebe ein
-- Tupel ohne Rolle zurück, und eine spätere Rolle mit demselben Schlüssel gäbe seine Rechte ungeprüft weiter).
CREATE FUNCTION app.custom_role_place() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.relation LIKE 'c-%' THEN
    PERFORM 1 FROM {{schema}}.authz_role r WHERE r.tenant_id = NEW.tenant_id AND r.key = NEW.relation AND NEW.object_type = ANY (r.places) FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rolle % ist an % nicht zulässig', NEW.relation, NEW.object_type USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authz_tuple_custom_role BEFORE INSERT OR UPDATE OF relation, object_type ON {{schema}}.authz_tuple
  FOR EACH ROW EXECUTE FUNCTION app.custom_role_place();
REVOKE ALL ON FUNCTION app.custom_role_guard(), app.custom_role_place() FROM PUBLIC;

SELECT app.secure_tenant_tables();
CREATE POLICY owner_tenant ON {{schema}}.authz_role TO {{owner}} USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
