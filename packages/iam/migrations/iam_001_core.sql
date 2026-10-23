-- iam_001 Grundlage (Spezifikation Kap. 10.1, 10.3): Schema `app` für Funktionen, Schema der App für Tabellen,
-- Mandantenkontext je Transaktion und der automatische Schutz aller Tabellen mit `tenant_id`.
--
-- Muster für JEDE mandantenbezogene Tabelle (auch die der App):
--   tenant_id uuid NOT NULL als erste Spalte des Primärschlüssels,
--   ENABLE + FORCE ROW LEVEL SECURITY,
--   Policy tenant_isolation TO {{app}} (USING und WITH CHECK auf app.tenant_id()).
-- app.secure_tenant_tables() setzt das; der Migrations-Runner ruft sie nach jeder Migration auf.
-- Keine Funktion ist für PUBLIC ausführbar: ausführen darf nur, wem es ausdrücklich gegeben ist.

ALTER DEFAULT PRIVILEGES FOR ROLE {{owner}} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS app;      -- Funktionen
CREATE SCHEMA IF NOT EXISTS {{schema}};   -- Tabellen
REVOKE ALL ON SCHEMA app, {{schema}} FROM PUBLIC;
GRANT USAGE ON SCHEMA app, {{schema}} TO {{app}}, {{sched}};

-- ---------- Mandantenkontext (pro Transaktion per set_config(…, true) gesetzt, PgBouncer-tauglich)
CREATE FUNCTION app.tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app.principal_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.principal_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app.tenant_id(), app.principal_id() TO {{app}}, {{sched}};

-- ---------- RLS und Rechte für alle Tabellen mit tenant_id (ausser tenant)
-- Idempotent; neue Tabellen sind damit automatisch geschützt. Ruft nur der Runner als Besitzer-Rolle auf.
CREATE FUNCTION app.secure_tenant_tables() RETURNS int LANGUAGE plpgsql AS $$
DECLARE t text; n int := 0;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
           WHERE c.table_schema = '{{schema}}' AND c.column_name = 'tenant_id' AND c.table_name <> 'tenant'
  LOOP
    EXECUTE format('ALTER TABLE {{schema}}.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE {{schema}}.%I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = '{{schema}}' AND tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON {{schema}}.%I TO {{app}} USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.%I TO {{app}}', t);
      n := n + 1;
    END IF;
  END LOOP;
  EXECUTE 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA {{schema}} TO {{app}}, {{sched}}';
  RETURN n;
END $$;
