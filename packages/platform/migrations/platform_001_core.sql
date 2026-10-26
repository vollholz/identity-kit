-- @vollholz/platform 001: Warteschlange, Idempotenz, Outbox.
-- Mandant, Principal, Audit (Hash-Kette), Sitzung, rate_limit und replay_guard legen die Migrationen von
-- @vollholz/iam an, die vor dieser laufen. Jede Tabelle mit tenant_id erhält über app.secure_tenant_tables() RLS
-- (ENABLE, FORCE, Policy tenant_isolation) und die Rechte für {{app}}.
-- Platzhalter: {{schema}}, {{app}}, {{sched}} (platformMigrations).

-- ---------- Warteschlange (worker/queue.ts von @vollholz/platform)
CREATE TABLE {{schema}}.job (
  tenant_id     uuid NOT NULL REFERENCES {{schema}}.tenant (id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  run_at        timestamptz NOT NULL DEFAULT now(),
  dedupe_key    text,
  locked_by     text,
  heartbeat_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  PRIMARY KEY (tenant_id, id)
);
-- Doppelte Aufträge mit gleichem Schlüssel, solange einer offen ist
CREATE UNIQUE INDEX job_dedupe ON {{schema}}.job (tenant_id, kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX job_tenant_status ON {{schema}}.job (tenant_id, status, run_at);
-- Ausnahme von «tenant_id zuerst»: Der Scheduler sucht fällige Jobs über alle Mandanten (docs/mandantentrennung.md)
CREATE INDEX job_due ON {{schema}}.job (run_at) WHERE status = 'queued';
CREATE INDEX job_running ON {{schema}}.job (heartbeat_at) WHERE status = 'running';

-- ---------- Idempotenz schreibender Aufrufe (http/idempotency.ts)
CREATE TABLE {{schema}}.idempotency_key (
  tenant_id     uuid NOT NULL REFERENCES {{schema}}.tenant (id) ON DELETE CASCADE,
  principal_id  uuid NOT NULL,
  key           text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  method        text NOT NULL,
  path          text NOT NULL,
  request_hash  text NOT NULL,
  status_code   int,
  headers       jsonb NOT NULL DEFAULT '{}',
  body          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, key)
);
CREATE INDEX idempotency_key_expires ON {{schema}}.idempotency_key (tenant_id, expires_at);

-- ---------- Outbox (core/events.ts): Ereignisse in derselben Transaktion wie die Änderung
CREATE TABLE {{schema}}.outbox_event (
  tenant_id       uuid NOT NULL REFERENCES {{schema}}.tenant (id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  type            text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  subject         text,
  data            jsonb NOT NULL DEFAULT '{}',
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX outbox_event_tenant_time ON {{schema}}.outbox_event (tenant_id, created_at);
-- Ausnahme von «tenant_id zuerst»: Verteilung über alle Mandanten
CREATE INDEX outbox_event_pending ON {{schema}}.outbox_event (created_at) WHERE dispatched_at IS NULL;

SELECT app.secure_tenant_tables();

-- Scheduler ({{sched}}): Warteschlange und Outbox über alle Mandanten lesen; schreiben ohne Kontext (Abholen,
-- Abschluss, Verteilung, Aufräumen), mit gesetztem app.tenant_id nur in diesem Mandanten. Eingefügt wird nur im
-- Mandantenkontext (enqueue/emit in der fachlichen Transaktion, Rolle {{app}}).
GRANT SELECT, UPDATE, DELETE ON {{schema}}.job, {{schema}}.outbox_event TO {{sched}};
CREATE POLICY sched_read ON {{schema}}.job FOR SELECT TO {{sched}} USING (true);
CREATE POLICY sched_write ON {{schema}}.job TO {{sched}}
  USING (app.tenant_id() IS NULL OR tenant_id = app.tenant_id()) WITH CHECK (app.tenant_id() IS NULL OR tenant_id = app.tenant_id());
CREATE POLICY sched_read ON {{schema}}.outbox_event FOR SELECT TO {{sched}} USING (true);
CREATE POLICY sched_write ON {{schema}}.outbox_event TO {{sched}}
  USING (app.tenant_id() IS NULL OR tenant_id = app.tenant_id()) WITH CHECK (app.tenant_id() IS NULL OR tenant_id = app.tenant_id());
-- Aufräumen der Idempotenz über alle Mandanten
GRANT SELECT, DELETE ON {{schema}}.idempotency_key TO {{sched}};
CREATE POLICY sched_cleanup ON {{schema}}.idempotency_key FOR DELETE TO {{sched}} USING (expires_at < now());
CREATE POLICY sched_read ON {{schema}}.idempotency_key FOR SELECT TO {{sched}} USING (expires_at < now());
