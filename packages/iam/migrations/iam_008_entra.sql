-- iam_008 Anmeldung über Microsoft Entra ID je Organisation (Spezifikation Kap. 9.4, KANN; aus Assets 046).
-- Die Tabellen bestehen immer (leer ohne ENTRA_CLIENT_ID), weil der Resolver app.entra_login_alias immer fragt.
--
-- entra_connection: höchstens eine Verbindung je Mandant. `stage` pending = Anbieter eingerichtet, Passwörter gelten
-- weiter; erst nach einer Testanmeldung `enforced` («Nur Entra»). `domains`: Domänen, deren Personen sich nur noch über
-- Entra anmelden; `idp_alias`: Anbieter in Keycloak (`entra-001` …), eindeutig über alle Mandanten.
-- entra_consent: offene Admin-Zustimmungen (state nur als SHA-256), 15 Minuten gültig, einmal einlösbar.
-- Funktionen ohne Mandantenkontext (SECURITY DEFINER, geben keine fremden Daten preis): entra_login_alias (nur der
-- Alias, nie der Mandant), entra_free_slot (kleinster freier Alias), entra_domains_taken (welche Domänen ein anderer
-- Mandant gebunden hat, ohne zu sagen, welcher).

CREATE TABLE {{schema}}.entra_connection (
  tenant_id uuid PRIMARY KEY REFERENCES {{schema}}.tenant(id),
  entra_tenant_id uuid NOT NULL,
  entra_name text NOT NULL DEFAULT '' CHECK (length(entra_name) <= 256),
  idp_alias text NOT NULL UNIQUE CHECK (idp_alias ~ '^entra-[0-9]{3}$'),
  domains text[] NOT NULL CHECK (cardinality(domains) BETWEEN 1 AND 50),
  -- alle verifizierten Domänen des Tenants beim letzten Lesen (Auswahl in der Oberfläche)
  tenant_domains text[] NOT NULL DEFAULT '{}',
  -- Domänen, die die Verbindung in Keycloak neu an der Organisation eingetragen hat (beim Trennen wieder entfernt)
  kc_domains_added text[] NOT NULL DEFAULT '{}',
  stage text NOT NULL DEFAULT 'pending' CHECK (stage IN ('pending', 'enforced')),
  tested_at timestamptz,
  tested_by_name text,
  enforced_at timestamptz,
  enforced_by_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error')),
  last_error text CHECK (length(last_error) <= 1000),
  connected_at timestamptz NOT NULL DEFAULT now(),
  connected_by_name text NOT NULL DEFAULT '',
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entra_connection_domains ON {{schema}}.entra_connection USING gin (domains);

CREATE TABLE {{schema}}.entra_consent (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  state_hash text PRIMARY KEY,
  entra_tenant_id uuid NOT NULL,
  subject text NOT NULL,               -- Keycloak-ID der Person, die die Zustimmung gestartet hat
  platform boolean NOT NULL,           -- gestartet von der Plattform-Administration
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX entra_consent_expires ON {{schema}}.entra_consent (expires_at);

SELECT app.secure_tenant_tables();

-- entra_connection unterliegt FORCE RLS auch für die Besitzer-Rolle: Die Funktionen lesen über eine eigene Policy der
-- Besitzer-Rolle, die nur greift, solange app.entra_scan gesetzt ist – das tun nur diese Funktionen, und sie setzen den
-- vorherigen Wert danach zurück. Andere Rollen betrifft die Policy nicht.
CREATE POLICY entra_scan ON {{schema}}.entra_connection FOR SELECT TO {{owner}} USING (current_setting('app.entra_scan', true) = 'on');

CREATE FUNCTION app.entra_login_alias(p_domain text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
DECLARE prev text := coalesce(current_setting('app.entra_scan', true), ''); v text;
BEGIN
  PERFORM set_config('app.entra_scan', 'on', true);
  SELECT c.idp_alias INTO v FROM {{schema}}.entra_connection c JOIN {{schema}}.tenant t ON t.id = c.tenant_id
   WHERE lower(p_domain) = ANY (c.domains) AND c.stage = 'enforced' AND t.status = 'active' LIMIT 1;
  PERFORM set_config('app.entra_scan', prev, true);
  RETURN v;
END $$;

CREATE FUNCTION app.entra_free_slot(p_max int) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
DECLARE prev text := coalesce(current_setting('app.entra_scan', true), ''); v text;
BEGIN
  PERFORM set_config('app.entra_scan', 'on', true);
  SELECT format('entra-%s', lpad(n::text, 3, '0')) INTO v FROM generate_series(1, least(greatest(p_max, 0), 999)) n
   WHERE NOT EXISTS (SELECT 1 FROM {{schema}}.entra_connection c WHERE c.idp_alias = format('entra-%s', lpad(n::text, 3, '0')))
   ORDER BY n LIMIT 1;
  PERFORM set_config('app.entra_scan', prev, true);
  RETURN v;
END $$;

-- Nur mit gesetztem Mandantenkontext: Domänen anderer Mandanten, nie die des eigenen
CREATE FUNCTION app.entra_domains_taken(p_domains text[]) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
DECLARE prev text := coalesce(current_setting('app.entra_scan', true), ''); v text[];
BEGIN
  IF app.tenant_id() IS NULL THEN RETURN NULL; END IF;
  PERFORM set_config('app.entra_scan', 'on', true);
  SELECT coalesce(array_agg(DISTINCT d ORDER BY d), '{}') INTO v FROM {{schema}}.entra_connection c, unnest(c.domains) d
   WHERE c.tenant_id <> app.tenant_id() AND d = ANY (p_domains);
  PERFORM set_config('app.entra_scan', prev, true);
  RETURN v;
END $$;

REVOKE ALL ON FUNCTION app.entra_login_alias(text), app.entra_free_slot(int), app.entra_domains_taken(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.entra_login_alias(text), app.entra_free_slot(int), app.entra_domains_taken(text[]) TO {{app}};
