-- iam_002 Mandanten (Spezifikation Kap. 4, 10.2; aus Assets 001, 008, 016, 020): eine Zeile je Keycloak-Organisation.
--
-- - Kein FORCE: Besitzer-Funktionen (resolve_tenant, ACL-Version) brauchen Zugriff über alle Mandanten. Die Laufzeit
--   sieht nur den eigenen Mandanten (tenant_self) und ändert nur Name und Einstellungen.
-- - app.resolve_tenant bindet den Mandanten an die ID der Organisation: Trägt das Token die ID und weicht sie von der
--   gespeicherten ab (Organisation gelöscht, neue mit gleichem Alias), kein Zugriff auf den alten Mandanten. Fehlt die
--   gespeicherte ID, wird sie beim ersten Zugriff mit ID festgehalten. Gesperrte Mandanten liefern NULL.
-- - Plattform-Administration und Worker lesen über SECURITY-DEFINER-Funktionen mit festem search_path; die API ruft
--   sie nur für platform-admin auf.

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

-- Auflösen bzw. Anlegen eines Mandanten anhand des Organisations-Alias. SECURITY DEFINER, weil der Kontext erst danach
-- gesetzt werden kann; gibt nur die ID zurück, keine fremden Daten.
CREATE FUNCTION app.resolve_tenant(p_alias text, p_kc_org_id text, p_name text, p_create boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
DECLARE v_id uuid; v_status text; v_kc text;
BEGIN
  SELECT id, status, kc_org_id INTO v_id, v_status, v_kc FROM {{schema}}.tenant WHERE alias = lower(p_alias);
  IF v_id IS NULL AND p_create THEN
    INSERT INTO {{schema}}.tenant (alias, kc_org_id, name) VALUES (lower(p_alias), p_kc_org_id, coalesce(p_name, p_alias))
      ON CONFLICT (alias) DO UPDATE SET alias = excluded.alias RETURNING id, status, kc_org_id INTO v_id, v_status, v_kc;
  END IF;
  IF v_status = 'suspended' THEN RETURN NULL; END IF;
  IF v_id IS NOT NULL AND p_kc_org_id IS NOT NULL THEN
    IF v_kc IS NULL THEN
      UPDATE {{schema}}.tenant SET kc_org_id = p_kc_org_id WHERE id = v_id AND kc_org_id IS NULL AND NOT EXISTS (SELECT 1 FROM {{schema}}.tenant WHERE kc_org_id = p_kc_org_id);
    ELSIF v_kc <> p_kc_org_id THEN RETURN NULL;
    END IF;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.resolve_tenant(text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_tenant(text, text, text, boolean) TO {{app}};

-- Jede Änderung an Zugriffsregeln und eigenen Rollen erhöht die Version des Mandanten (Zwischenspeicher der Rechte).
CREATE FUNCTION app.bump_acl_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
BEGIN
  UPDATE {{schema}}.tenant SET acl_version = acl_version + 1 WHERE id = coalesce(NEW.tenant_id, OLD.tenant_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.bump_acl_version() FROM PUBLIC;

-- Gesperrte Mandanten: der Worker holt deren Jobs nicht ab (Laufzeit-Rollen sehen ohne Kontext keine Mandanten).
CREATE FUNCTION app.suspended_tenants() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS
  $$ SELECT coalesce(array_agg(id), '{}') FROM {{schema}}.tenant WHERE status = 'suspended' $$;
REVOKE ALL ON FUNCTION app.suspended_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.suspended_tenants() TO {{sched}};

-- Plattform-Administration: Mandanten aller Organisationen lesen und den Status setzen.
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

REVOKE ALL ON FUNCTION app.platform_tenants() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_tenant_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_tenants() TO {{app}};
GRANT EXECUTE ON FUNCTION app.set_tenant_status(uuid, text) TO {{app}};
