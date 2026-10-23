-- iam_015 Authz neu: Freigaben als Tupel, Freigabestufe und Lesesicht je Anfrage (Spezifikation Kap. 7.4–7.8, 10.2,
-- 10.3; Konzept 3.2–3.5). Greenfield: Zugriffsregeln, eigene Rollen und Freigaben von Clients entfallen ohne Übernahme.
--
-- authz_tuple: «Subjekt hat Relation an Ort». Relationen und Typen kommen aus dem Modell der App und ändern sich mit
-- ihm: ihre CHECKs (authz_tuple_relation_check, authz_tuple_object_type_check) setzt der Runner nach den Migrationen
-- (syncModelChecks). Welche Relation an welchem Typ zulässig ist, prüft die API. Jede Änderung erhöht
-- tenant.acl_version (Anweisungs-Trigger, Mandant des Kontexts).
--
-- principal: Freigabestufe (clearance, Break-Glass über clearance_boost bis clearance_until); Änderungen erhöhen
-- acl_version. Maschinen-Clients: subject = client_id (Client-ID der Freigabe), eindeutig je Mandant (A18); der
-- Principal entsteht spätestens mit der Freigabe. last_roles entfällt (Rollen sind Tupel).
--
-- Lesesicht: Der Baukasten setzt je Anfrage in derselben Transaktion app.subjects, app.clearance, app.read_all, … ; die
-- App liest sie in ihren RLS-Policies nur über diese Funktionen (STABLE, SECURITY INVOKER, search_path fest, EXECUTE nur
-- für {{app}}). Ohne Einstellung: leeres Array, false bzw. 0.
--
-- Erste Organisation (iam-org-bootstrap, A20): Die Besitzer-Rolle schreibt Principal, Tupel und Audit im Kontext des
-- Mandanten (Policies owner_tenant); ohne Kontext sieht auch sie nichts.

DROP TABLE {{schema}}.acl_entry, {{schema}}.tenant_role, {{schema}}.client_grant;

-- ---------- Version: Zeilen-Trigger mit NEW/OLD, Anweisungs-Trigger für den Mandanten des Kontexts
CREATE OR REPLACE FUNCTION app.bump_acl_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
BEGIN
  IF TG_LEVEL = 'ROW' THEN
    UPDATE {{schema}}.tenant SET acl_version = acl_version + 1 WHERE id = coalesce(NEW.tenant_id, OLD.tenant_id);
  ELSE
    UPDATE {{schema}}.tenant SET acl_version = acl_version + 1 WHERE id = app.tenant_id();
  END IF;
  RETURN NULL;
END $$;

-- ---------- Principal
ALTER TABLE {{schema}}.principal
  DROP COLUMN last_roles,
  ADD COLUMN clearance smallint NOT NULL DEFAULT 0 CHECK (clearance BETWEEN 0 AND 2),
  ADD COLUMN clearance_boost smallint CHECK (clearance_boost BETWEEN 0 AND 2),
  ADD COLUMN clearance_until timestamptz,
  ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by_name text,
  ADD CONSTRAINT principal_clearance_boost CHECK ((clearance_until IS NULL) = (clearance_boost IS NULL)),
  ADD CONSTRAINT principal_client_id CHECK (kind <> 'client' OR (client_id = subject AND client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'));
CREATE UNIQUE INDEX principal_client ON {{schema}}.principal (tenant_id, client_id) WHERE kind = 'client';
CREATE TRIGGER principal_clearance_version AFTER UPDATE OF clearance, clearance_boost, clearance_until ON {{schema}}.principal
  FOR EACH ROW WHEN (OLD.clearance IS DISTINCT FROM NEW.clearance OR OLD.clearance_boost IS DISTINCT FROM NEW.clearance_boost OR OLD.clearance_until IS DISTINCT FROM NEW.clearance_until)
  EXECUTE FUNCTION app.bump_acl_version();

-- ---------- Tupel
CREATE TABLE {{schema}}.authz_tuple (
  tenant_id   uuid NOT NULL REFERENCES {{schema}}.tenant (id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  subject     text NOT NULL,          -- 'user:<uuid>' | 'client:<uuid>' | 'group:<entra-object-id>' | 'org:members'
  relation    text NOT NULL,          -- Rolle des Modells, Beziehung ohne Rechte ('member'), 'owner'
  object_type text NOT NULL,          -- Typ des Modells
  object_id   uuid,                   -- leer genau bei 'org'
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,                   -- principal.id; leer bei Plattform-Administration und System
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT authz_tuple_subject_check CHECK (
    subject ~ '^(user|client|group):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR subject = 'org:members'),
  CONSTRAINT authz_tuple_org_check CHECK ((object_type = 'org') = (object_id IS NULL)),
  CONSTRAINT authz_tuple_client_check CHECK (subject NOT LIKE 'client:%' OR object_type = 'org'),
  CONSTRAINT authz_tuple_unique UNIQUE NULLS NOT DISTINCT (tenant_id, subject, relation, object_type, object_id)
);
CREATE INDEX authz_tuple_object_idx  ON {{schema}}.authz_tuple (tenant_id, object_type, object_id);
CREATE INDEX authz_tuple_subject_idx ON {{schema}}.authz_tuple (tenant_id, subject);
CREATE INDEX authz_tuple_expires_idx ON {{schema}}.authz_tuple (expires_at) WHERE expires_at IS NOT NULL;
CREATE TRIGGER authz_tuple_acl_version AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.authz_tuple
  FOR EACH STATEMENT EXECUTE FUNCTION app.bump_acl_version();

SELECT app.secure_tenant_tables();
CREATE POLICY owner_tenant ON {{schema}}.principal TO {{owner}} USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY owner_tenant ON {{schema}}.authz_tuple TO {{owner}} USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY owner_tenant ON {{schema}}.audit_log TO {{owner}} USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());

-- ---------- Lesesicht
CREATE FUNCTION app.subjects() RETURNS text[] LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.subjects', true), '')::text[], '{}') $$;
CREATE FUNCTION app.clearance() RETURNS smallint LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.clearance', true), '')::smallint, 0::smallint) $$;
CREATE FUNCTION app.read_all() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.read_all', true), '')::boolean, false) $$;
CREATE FUNCTION app.write_all() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.write_all', true), '')::boolean, false) $$;
CREATE FUNCTION app.read_types() RETURNS uuid[] LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.read_types', true), '')::uuid[], '{}') $$;
CREATE FUNCTION app.write_types() RETURNS uuid[] LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.write_types', true), '')::uuid[], '{}') $$;
CREATE FUNCTION app.read_units() RETURNS uuid[] LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.read_units', true), '')::uuid[], '{}') $$;
CREATE FUNCTION app.write_units() RETURNS uuid[] LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.write_units', true), '')::uuid[], '{}') $$;
CREATE FUNCTION app.read_relations() RETURNS text[] LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.read_relations', true), '')::text[], '{}') $$;
CREATE FUNCTION app.write_relations() RETURNS text[] LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(nullif(current_setting('app.write_relations', true), '')::text[], '{}') $$;
-- Recht gilt an org (Rollen an org ∩ Scope); app.org_permissions als text[]
CREATE FUNCTION app.read_all_of(p_permission text) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT p_permission = ANY (coalesce(nullif(current_setting('app.org_permissions', true), '')::text[], '{}')) $$;
-- Relationen, die ein Recht enthalten (∩ Scope); app.permission_relations als JSON-Objekt Recht → Liste
CREATE FUNCTION app.relations_of(p_permission text) RETURNS text[] LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(ARRAY(SELECT jsonb_array_elements_text(nullif(current_setting('app.permission_relations', true), '')::jsonb -> p_permission)), '{}') $$;
-- Nicht abgelaufenes Tupel eines Subjekts der Anfrage mit einer der Relationen an dieser Ressource
CREATE FUNCTION app.has_tuple(p_object_type text, p_object_id uuid, p_relations text[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path = {{schema}}, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM {{schema}}.authz_tuple t
    WHERE t.tenant_id = app.tenant_id() AND t.object_type = p_object_type AND t.object_id = p_object_id
      AND t.relation = ANY (p_relations) AND t.subject = ANY (app.subjects())
      AND (t.expires_at IS NULL OR t.expires_at > now()))
$$;
GRANT EXECUTE ON FUNCTION app.subjects(), app.clearance(), app.read_all(), app.write_all(), app.read_types(), app.write_types(),
  app.read_units(), app.write_units(), app.read_relations(), app.write_relations(), app.read_all_of(text), app.relations_of(text),
  app.has_tuple(text, uuid, text[]) TO {{app}};
