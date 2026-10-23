-- iam_002 Mandanten (Spezifikation Kap. 4, 10.2): eine Zeile je Keycloak-Organisation.
--
-- - Kein FORCE: Besitzer-Funktionen (resolve_tenant, acl_version) brauchen Zugriff über alle Mandanten. Die Laufzeit
--   sieht nur den eigenen Mandanten (tenant_self) und ändert nur Name und Einstellungen.
-- - app.resolve_tenant bindet den Mandanten an die ID der Organisation: Trägt das Token die ID und weicht sie von der
--   gespeicherten ab (Organisation gelöscht, neue mit gleichem Alias), kein Zugriff auf den alten Mandanten. Fehlt die
--   gespeicherte ID, wird sie beim ersten Zugriff festgehalten – nur, wenn sie keinem anderen Mandanten gehört.
--   Nur ASCII-Aliasse (nur A–Z wird klein, nie Unicode-Faltung wie beim Kelvin-Zeichen). Gesperrt → NULL.
-- - Plattform-Administration und Worker lesen über SECURITY-DEFINER-Funktionen mit festem search_path.

CREATE TABLE {{schema}}.tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kc_org_id text UNIQUE,
  alias text NOT NULL UNIQUE CHECK (alias ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  acl_version bigint NOT NULL DEFAULT 1,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE {{schema}}.tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON {{schema}}.tenant TO {{app}} USING (id = app.tenant_id()) WITH CHECK (id = app.tenant_id());
GRANT SELECT, UPDATE (name, settings) ON {{schema}}.tenant TO {{app}};

CREATE FUNCTION app.resolve_tenant(p_alias text, p_kc_org_id text, p_name text, p_create boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
DECLARE v_id uuid; v_status text; v_kc text; v_alias text;
BEGIN
  IF p_alias IS NULL OR p_alias !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$' THEN RETURN NULL; END IF;
  v_alias := translate(p_alias, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
  SELECT id, status, kc_org_id INTO v_id, v_status, v_kc FROM {{schema}}.tenant WHERE alias = v_alias;
  IF v_id IS NULL AND p_create THEN
    -- Ohne Ziel: auch eine Organisations-ID, die schon einem anderen Mandanten gehört, ist kein Fehler (sonst 500)
    INSERT INTO {{schema}}.tenant (alias, kc_org_id, name) VALUES (v_alias, p_kc_org_id, coalesce(p_name, p_alias))
      ON CONFLICT DO NOTHING RETURNING id, status, kc_org_id INTO v_id, v_status, v_kc;
    IF v_id IS NULL THEN
      SELECT id, status, kc_org_id INTO v_id, v_status, v_kc FROM {{schema}}.tenant WHERE alias = v_alias;
      IF v_id IS NULL THEN RETURN NULL; END IF;
    END IF;
  END IF;
  IF v_status = 'suspended' THEN RETURN NULL; END IF;
  IF v_id IS NOT NULL AND p_kc_org_id IS NOT NULL THEN
    IF v_kc IS NULL THEN
      UPDATE {{schema}}.tenant SET kc_org_id = p_kc_org_id WHERE id = v_id AND kc_org_id IS NULL AND NOT EXISTS (SELECT 1 FROM {{schema}}.tenant WHERE kc_org_id = p_kc_org_id);
      SELECT kc_org_id INTO v_kc FROM {{schema}}.tenant WHERE id = v_id;
    END IF;
    IF v_kc IS DISTINCT FROM p_kc_org_id THEN RETURN NULL; END IF;
  END IF;
  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION app.resolve_tenant(text, text, text, boolean) TO {{app}};

-- Jede Änderung an Tupeln und Freigabestufen erhöht die Version des Mandanten (Zwischenspeicher der Rechte). Als
-- Zeilen-Trigger mit NEW/OLD, als Anweisungs-Trigger für den Mandanten des Kontexts (RLS lässt nur diesen zu).
CREATE FUNCTION app.bump_acl_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
BEGIN
  IF TG_LEVEL = 'ROW' THEN
    UPDATE {{schema}}.tenant SET acl_version = acl_version + 1 WHERE id = coalesce(NEW.tenant_id, OLD.tenant_id);
  ELSE
    UPDATE {{schema}}.tenant SET acl_version = acl_version + 1 WHERE id = app.tenant_id();
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION app.suspended_tenants() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS
  $$ SELECT coalesce(array_agg(id), '{}') FROM {{schema}}.tenant WHERE status = 'suspended' $$;
GRANT EXECUTE ON FUNCTION app.suspended_tenants() TO {{sched}};

CREATE FUNCTION app.platform_tenants()
RETURNS TABLE (id uuid, alias text, name text, status text, kc_org_id text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS
  $$ SELECT id, alias, name, status, kc_org_id, created_at FROM {{schema}}.tenant ORDER BY alias $$;

CREATE FUNCTION app.set_tenant_status(p_id uuid, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
BEGIN
  IF p_status NOT IN ('active', 'suspended') THEN RAISE EXCEPTION 'Status % ungültig', p_status USING ERRCODE = '22023'; END IF;
  UPDATE {{schema}}.tenant SET status = p_status WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Mandant % nicht gefunden', p_id USING ERRCODE = 'P0002'; END IF;
END $$;
GRANT EXECUTE ON FUNCTION app.platform_tenants(), app.set_tenant_status(uuid, text) TO {{app}};
