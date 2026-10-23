-- iam_004 Freigaben als Tupel und Lesesicht je Anfrage (Spezifikation Kap. 7.4, 7.6, 10.2, 10.3).
--
-- authz_tuple: «Subjekt hat Relation an Ort». Relationen und Typen kommen aus dem Modell der App und ändern sich mit
-- ihm: ihre CHECKs (authz_tuple_relation_check, authz_tuple_object_type_check) setzt der Runner nach den Migrationen
-- (syncModelChecks), nicht diese Migration. Welche Relation an welchem Typ zulässig ist, prüft die API.
-- Jede Änderung erhöht tenant.acl_version (Anweisungs-Trigger, Mandant des Kontexts).
--
-- Lesesicht: Der Baukasten setzt je Anfrage in derselben Transaktion app.subjects, app.clearance, app.read_all, … ; die
-- App liest sie in ihren RLS-Policies nur über diese Funktionen (STABLE, SECURITY INVOKER, search_path fest, EXECUTE
-- nur für {{app}}). Ohne Einstellung: leeres Array, false bzw. 0.
--
-- Erste Organisation (iam-org-bootstrap, A20): Die Besitzer-Rolle schreibt Principal, Tupel und Audit im Kontext des
-- Mandanten (Policies owner_tenant); ohne Kontext sieht auch sie nichts.

CREATE TABLE {{schema}}.authz_tuple (
  tenant_id   uuid NOT NULL REFERENCES {{schema}}.tenant (id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  subject     text NOT NULL,
  relation    text NOT NULL,
  object_type text NOT NULL,
  object_id   uuid,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
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
