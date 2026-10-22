-- Fehlerhaft geschütztes Schema: jede Prüfung in rls.ts muss hier einen Befund liefern
CREATE SCHEMA app;
CREATE SCHEMA kit;
GRANT USAGE ON SCHEMA app, kit TO iamkit_app;
-- PUBLIC erreicht das Schema app (und damit seine Funktionen mit Standardrecht EXECUTE)
GRANT USAGE ON SCHEMA app TO PUBLIC;

CREATE FUNCTION app.tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE kit.tenant (id uuid PRIMARY KEY, alias text NOT NULL UNIQUE);

-- RLS ohne FORCE
CREATE TABLE kit.note (tenant_id uuid NOT NULL, id uuid NOT NULL, body text, PRIMARY KEY (tenant_id, id));
ALTER TABLE kit.note ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kit.note TO iamkit_app USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON kit.note TO iamkit_app;

-- Policy mit falschem Ausdruck
CREATE TABLE kit.comment (tenant_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (tenant_id, id));
ALTER TABLE kit.comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE kit.comment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kit.comment TO iamkit_app USING (true) WITH CHECK (true);
GRANT SELECT ON kit.comment TO iamkit_app;

-- Tabelle ohne tenant_id mit Rechten, nicht ausgenommen
CREATE TABLE kit.leak (id uuid PRIMARY KEY, secret text);
GRANT SELECT ON kit.leak TO iamkit_app;

-- SECURITY DEFINER ohne search_path, PUBLIC darf ausführen (Standard)
CREATE FUNCTION app.resolve_tenant(p_alias text) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS
  $$ SELECT id FROM kit.tenant WHERE alias = p_alias $$;

-- Funktion in einem Schema ohne USAGE für PUBLIC: nur mit strict gemeldet
CREATE FUNCTION kit.helper() RETURNS int LANGUAGE sql AS 'SELECT 1';
