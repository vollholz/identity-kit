-- Kleines, korrekt geschütztes Schema nach Spezifikation Kap. 10 (Rollen: iamkit_owner, iamkit_app)
CREATE SCHEMA app;
CREATE SCHEMA kit;
REVOKE ALL ON SCHEMA app, kit FROM PUBLIC;
GRANT USAGE ON SCHEMA app, kit TO iamkit_app;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE FUNCTION app.tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app.tenant_id() TO iamkit_app;

CREATE TABLE kit.tenant (id uuid PRIMARY KEY, alias text NOT NULL UNIQUE);

CREATE TABLE kit.note (tenant_id uuid NOT NULL REFERENCES kit.tenant(id), id uuid NOT NULL, body text, PRIMARY KEY (tenant_id, id));
ALTER TABLE kit.note ENABLE ROW LEVEL SECURITY;
ALTER TABLE kit.note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kit.note TO iamkit_app USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON kit.note TO iamkit_app;

CREATE TABLE kit.session (id text PRIMARY KEY, data bytea NOT NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON kit.session TO iamkit_app;

CREATE FUNCTION app.resolve_tenant(p_alias text) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = kit, pg_temp AS
  $$ SELECT id FROM kit.tenant WHERE alias = p_alias $$;
GRANT EXECUTE ON FUNCTION app.resolve_tenant(text) TO iamkit_app;
