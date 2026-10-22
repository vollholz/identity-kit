-- iam_007 Audit-Protokoll (Spezifikation Kap. 9.1 Nr. 8, 10.2; aus Assets 001, 003, 009, 044).
--
-- - Je Mandant lückenlose Folgenummer `seq` und Hash-Kette über alle Felder in kanonischer Form (Version 2). Der Trigger
--   verkettet unter einer Sperre je Mandant (`audit:<tenant>`); dieselbe Sperre nimmt eine Outbox der App, damit
--   Ereignis und Eintrag derselben Transaktion sich nicht verklemmen.
-- - Anker halten den Stand (seq, hash) fest; so fällt auch das Löschen der jüngsten Einträge auf.
-- - Die Laufzeit darf nur lesen und anhängen.
-- - Danach: neue Funktionen der Besitzer-Rolle sind nicht mehr für PUBLIC ausführbar (jede Migration vergibt EXECUTE
--   ausdrücklich).

CREATE TABLE {{schema}}.audit_log (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL,
  actor_id uuid,
  actor_name text,
  client_id text,
  source text NOT NULL CHECK (source IN ('ui', 'api', 'mcp', 'worker', 'webhook', 'system')),
  action text NOT NULL,
  resource_type text,
  resource_id uuid,
  correlation_id text,
  data jsonb NOT NULL DEFAULT '{}',
  prev_hash bytea,
  hash bytea NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX audit_log_resource ON {{schema}}.audit_log (tenant_id, resource_type, resource_id, ts DESC);
CREATE INDEX audit_log_ts ON {{schema}}.audit_log (tenant_id, ts);
CREATE INDEX audit_log_action ON {{schema}}.audit_log (tenant_id, action, id);
CREATE INDEX audit_log_actor ON {{schema}}.audit_log (tenant_id, actor_id, id);
CREATE UNIQUE INDEX audit_log_seq ON {{schema}}.audit_log (tenant_id, seq);

CREATE FUNCTION app.audit_hash(prev bytea, r {{schema}}.audit_log) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(convert_to(
    coalesce(encode(prev, 'hex'), '') || '|' ||
    jsonb_build_array(
      2, r.tenant_id, r.seq,
      to_char(r.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      r.actor_kind, r.actor_id, r.actor_name, r.client_id, r.source,
      r.action, r.resource_type, r.resource_id, r.correlation_id, r.data
    )::text, 'UTF8'))
$$;

CREATE FUNCTION app.audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last record;
BEGIN
  -- Sperre bis Transaktionsende: Einträge eines Mandanten werden strikt nacheinander verkettet.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.tenant_id::text, 0));
  SELECT seq, hash INTO last FROM {{schema}}.audit_log WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  NEW.ts := date_trunc('microseconds', NEW.ts);
  NEW.seq := coalesce(last.seq, 0) + 1;
  NEW.prev_hash := last.hash;
  NEW.hash := app.audit_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON {{schema}}.audit_log FOR EACH ROW EXECUTE FUNCTION app.audit_chain();

-- Anker: festgehaltener Stand der Kette. Nur anhängen.
CREATE TABLE {{schema}}.audit_anchor (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  seq bigint NOT NULL,
  hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (tenant_id, seq)
);

-- Rechte jetzt setzen, damit sie sich danach einschränken lassen
SELECT app.secure_tenant_tables();
REVOKE UPDATE, DELETE ON {{schema}}.audit_log, {{schema}}.audit_anchor FROM {{app}};

ALTER DEFAULT PRIVILEGES FOR ROLE {{owner}} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
