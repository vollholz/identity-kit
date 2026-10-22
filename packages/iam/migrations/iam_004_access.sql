-- iam_004 Zugriffsregeln und eigene Rollen (Spezifikation Kap. 7.1, 8.3; aus Assets 001, 003, 036, 048, 049).
--
-- acl_entry: Wirkung `restrict` (nur passende Principals behalten das Recht), `deny` (verbietet), `grant` (gibt das
-- Recht ohne Rolle, nie auf einem Blatt der Kette). Ressourcentypen und Blätter kommen aus dem Katalog der App.
-- tenant_role: eigene Rollen der Organisation; `key` (`c-…`) ist zugleich Name der Keycloak-Gruppe
-- `<prefix>/<alias>/<key>` und ändert sich nie. Gelöschte Rollen bleiben als Grabstein (`deleted_at`), ihr Schlüssel
-- wird nie wieder vergeben. Änderungen an beiden Tabellen erhöhen tenant.acl_version.

CREATE TABLE {{schema}}.acl_entry (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  resource_type text NOT NULL CHECK (resource_type IN ({{resource_types}})),
  resource_id uuid,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'group', 'role', 'client')),
  principal_ref text NOT NULL,
  permission text NOT NULL,
  effect text NOT NULL DEFAULT 'restrict' CHECK (effect IN ('restrict', 'deny', 'grant')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (tenant_id, id),
  CHECK ((resource_type = 'tenant') = (resource_id IS NULL)){{grant_check}}
);
CREATE INDEX acl_entry_resource ON {{schema}}.acl_entry (tenant_id, resource_type, resource_id);
CREATE INDEX acl_entry_principal ON {{schema}}.acl_entry (tenant_id, principal_type, principal_ref);
CREATE TRIGGER acl_entry_version AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.acl_entry FOR EACH ROW EXECUTE FUNCTION app.bump_acl_version();

CREATE TABLE {{schema}}.tenant_role (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL CHECK (key ~ '^c-[a-z0-9][a-z0-9-]{0,40}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  permissions text[] NOT NULL CHECK (cardinality(permissions) BETWEEN 1 AND 100),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, key)
);
CREATE UNIQUE INDEX tenant_role_label ON {{schema}}.tenant_role (tenant_id, lower(btrim(label))) WHERE deleted_at IS NULL;
CREATE TRIGGER tenant_role_version AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.tenant_role FOR EACH ROW EXECUTE FUNCTION app.bump_acl_version();
