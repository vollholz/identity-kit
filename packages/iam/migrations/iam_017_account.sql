-- iam_017 Konto ohne Organisation (Spezifikation Kap. 6.3): Konten der Personen über allen Mandanten und Protokoll der
-- Plattform.
--
-- - account: eine Zeile je Person in Keycloak (`sub`), unabhängig von Mitgliedschaften. Nötig für Anfragen ohne
--   Organisation (Kontext «Konto»: Organisation erstellen, Plattform-Administration) und für die Begrenzung der selbst
--   erstellten Organisationen. Kein Mandantenbezug; die Laufzeit hat keine Rechte an der Tabelle und arbeitet nur über
--   die Funktionen unten. Mit `principal` (je Mandant) ist das Konto bewusst nicht verbunden: Mandanten sollen dieselbe
--   Person nicht über eine gemeinsame Kennung verknüpfen können.
-- - platform_audit_log: eine Hash-Kette für alles, was nicht in einem Mandanten geschieht oder über Mandanten hinweg
--   wirkt (Konto, Plattform-Administration). Aufbau wie audit_log (iam_007), `org_id` nennt den betroffenen Mandanten
--   (bewusst nicht `tenant_id`, sonst behandelte app.secure_tenant_tables() die Tabelle als Mandantentabelle). Die
--   Laufzeit hängt nur über app.platform_audit() an und liest nichts.

CREATE TABLE {{schema}}.account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL UNIQUE,
  email text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  orgs_created int NOT NULL DEFAULT 0 CHECK (orgs_created >= 0)
);
REVOKE ALL ON {{schema}}.account FROM {{app}}, {{sched}};

CREATE TABLE {{schema}}.platform_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL,
  actor_id uuid,
  actor_name text,
  source text NOT NULL CHECK (source IN ('ui', 'api', 'mcp', 'worker', 'webhook', 'system')),
  action text NOT NULL,
  resource_type text,
  resource_id uuid,
  org_id uuid REFERENCES {{schema}}.tenant (id),
  correlation_id text,
  data jsonb NOT NULL DEFAULT '{}',
  prev_hash bytea,
  hash bytea NOT NULL,
  seq bigint NOT NULL UNIQUE
);
CREATE INDEX platform_audit_log_org ON {{schema}}.platform_audit_log (org_id, id);
CREATE INDEX platform_audit_log_actor ON {{schema}}.platform_audit_log (actor_id, id);
REVOKE ALL ON {{schema}}.platform_audit_log FROM {{app}}, {{sched}};

CREATE FUNCTION app.platform_audit_hash(prev bytea, r {{schema}}.platform_audit_log) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(convert_to(
    coalesce(encode(prev, 'hex'), '') || '|' ||
    jsonb_build_array(
      2, 'platform', r.seq,
      to_char(r.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      r.actor_kind, r.actor_id, r.actor_name, r.source,
      r.action, r.resource_type, r.resource_id, r.org_id, r.correlation_id, r.data
    )::text, 'UTF8'))
$$;

CREATE FUNCTION app.platform_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:platform', 0));
  SELECT seq, hash INTO last FROM {{schema}}.platform_audit_log ORDER BY seq DESC LIMIT 1;
  NEW.ts := date_trunc('microseconds', NEW.ts);
  NEW.seq := coalesce(last.seq, 0) + 1;
  NEW.prev_hash := last.hash;
  NEW.hash := app.platform_audit_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER platform_audit_log_chain BEFORE INSERT ON {{schema}}.platform_audit_log FOR EACH ROW EXECUTE FUNCTION app.platform_audit_chain();

-- Konto beim Zugriff anlegen bzw. Name, Adresse und letzten Zugriff nachführen; liefert die ID.
CREATE FUNCTION app.account_touch(p_subject text, p_email text, p_name text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
  INSERT INTO {{schema}}.account AS a (subject, email, display_name) VALUES (p_subject, p_email, p_name)
  ON CONFLICT (subject) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, last_seen_at = now()
  RETURNING id
$$;

-- Eine weitere selbst erstellte Organisation zählen, wenn das Konto die Höchstzahl noch nicht erreicht hat (atomar).
CREATE FUNCTION app.account_reserve_org(p_account uuid, p_limit int) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
  WITH u AS (UPDATE {{schema}}.account SET orgs_created = orgs_created + 1 WHERE id = p_account AND orgs_created < p_limit RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Reservierung zurückgeben (Erstellen gescheitert).
CREATE FUNCTION app.account_release_org(p_account uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
  UPDATE {{schema}}.account SET orgs_created = orgs_created - 1 WHERE id = p_account AND orgs_created > 0
$$;

-- Eintrag im Protokoll der Plattform (nur anhängen).
CREATE FUNCTION app.platform_audit(p_actor_kind text, p_actor_id uuid, p_actor_name text, p_source text, p_action text,
  p_resource_type text, p_resource_id uuid, p_org uuid, p_correlation text, p_data jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
  INSERT INTO {{schema}}.platform_audit_log (actor_kind, actor_id, actor_name, source, action, resource_type, resource_id, org_id, correlation_id, data)
  VALUES (p_actor_kind, p_actor_id, p_actor_name, p_source, p_action, p_resource_type, p_resource_id, p_org, p_correlation, coalesce(p_data, '{}'))
$$;

REVOKE EXECUTE ON FUNCTION app.account_touch(text, text, text), app.account_reserve_org(uuid, int), app.account_release_org(uuid),
  app.platform_audit(text, uuid, text, text, text, text, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_touch(text, text, text), app.account_reserve_org(uuid, int), app.account_release_org(uuid),
  app.platform_audit(text, uuid, text, text, text, text, uuid, uuid, text, jsonb) TO {{app}};
