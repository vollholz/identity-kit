-- iam_021 Betroffene Person im Audit, Suche und Lesen nach Recht (Spezifikation Kap. 9.1 Nr. 8, 10.2).
--
-- - audit_log.subject_id: Kennung der betroffenen Person, optional. Die App wählt die Art der Kennung (z. B. die ID
--   einer Person der App); höchstens 200 Zeichen, nie leer. Index (tenant_id, subject_id, ts) für die Suche nach
--   Person (nur Einträge mit Person), dazu (tenant_id, actor_id, ts) für die Suche nach Akteur und Zeitraum. Für das
--   Objekt besteht (tenant_id, resource_type, resource_id, ts) seit iam_007.
-- - Hash-Kette: Einträge ohne subject_id hashen unverändert (Version 2); mit subject_id gilt Version 3, dieselben Felder
--   und subject_id am Ende. Alle bestehenden Einträge und ihre Hashes bleiben gültig, die Prüfung bleibt
--   `hash = app.audit_hash(prev_hash, l)`.
-- - app.audit_read_permission(p): Wahl der App (in einer eigenen Migration), das Lesen des Audits für {{app}} an das
--   Recht p zu binden (Policy `audit_read`, RESTRICTIVE, nur SELECT): `SELECT app.audit_read_permission('audit:read')`.
--   Die Prüfung ist app.has_permission(p) (iam_018): Recht an org oder volle Sicht; ohne Lesesicht sieht die
--   Transaktion keine Einträge. Anhängen bleibt ohne Recht möglich: app.audit_chain() liest den letzten Eintrag dann als
--   Besitzer (SECURITY DEFINER, Policy owner_tenant, Mandant der Transaktion). `NULL` hebt die Bindung wieder auf. Ohne
--   Aufruf ändert sich nichts: Jede Transaktion der Organisation liest wie bisher.

ALTER TABLE {{schema}}.audit_log ADD COLUMN subject_id text CHECK (subject_id <> '' AND length(subject_id) <= 200);
CREATE INDEX audit_log_subject ON {{schema}}.audit_log (tenant_id, subject_id, ts) WHERE subject_id IS NOT NULL;
CREATE INDEX audit_log_actor_ts ON {{schema}}.audit_log (tenant_id, actor_id, ts) WHERE actor_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.audit_hash(prev bytea, r {{schema}}.audit_log) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(convert_to(
    coalesce(encode(prev, 'hex'), '') || '|' ||
    CASE WHEN r.subject_id IS NULL THEN jsonb_build_array(
      2, r.tenant_id, r.seq,
      to_char(r.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      r.actor_kind, r.actor_id, r.actor_name, r.client_id, r.source,
      r.action, r.resource_type, r.resource_id, r.correlation_id, r.data
    ) ELSE jsonb_build_array(
      3, r.tenant_id, r.seq,
      to_char(r.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      r.actor_kind, r.actor_id, r.actor_name, r.client_id, r.source,
      r.action, r.resource_type, r.resource_id, r.correlation_id, r.data, r.subject_id
    ) END::text, 'UTF8'))
$$;

CREATE FUNCTION app.audit_read_permission(p_permission text) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_permission IS NOT NULL AND p_permission !~ '^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$' THEN
    RAISE EXCEPTION 'Recht «%» ungültig (erwartet <typ>:<aktion>)', p_permission USING ERRCODE = '22023';
  END IF;
  DROP POLICY IF EXISTS audit_read ON {{schema}}.audit_log;
  IF p_permission IS NULL THEN
    ALTER FUNCTION app.audit_chain() SECURITY INVOKER;
    ALTER FUNCTION app.audit_chain() RESET search_path;
  ELSE
    ALTER FUNCTION app.audit_chain() SECURITY DEFINER;
    ALTER FUNCTION app.audit_chain() SET search_path = {{schema}}, pg_temp;
    EXECUTE format('CREATE POLICY audit_read ON {{schema}}.audit_log AS RESTRICTIVE FOR SELECT TO {{app}} USING (app.has_permission(%L))', p_permission);
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION app.audit_read_permission(text) FROM PUBLIC;
