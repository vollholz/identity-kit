-- iam_022 Produktmodule je Organisation (Konzept «Module je Organisation», Abschnitt 3): je Modul bzw. Teilfunktion
-- (`modul.teil`) zwei Schalter – `allowed` setzt der Betrieb, `active` die Organisation (aktiv nur, wenn erlaubt).
--
-- - Die Datenbank kennt das Modell nicht: Welche Module es gibt, was sie voraussetzen und welche Rechte daran hängen,
--   prüft das Paket. Fehlt eine Zeile, gilt «nicht erlaubt, nicht aktiv» – ausser für den Kern (immer aktiv) und für
--   Teilfunktionen (ohne Zeile wie ihr Modul). Bestehende Organisationen erhalten ihre Zeilen beim Abgleich nach den
--   Migrationen (alle Module erlaubt und aktiv, `migrate` mit dem Modell der App); app.backfill_modules ist das
--   Sicherheitsnetz beim ersten Laden einer Organisation ohne Zeilen.
-- - RLS ENABLE + FORCE über app.secure_tenant_tables; die Laufzeit liest nur (tenant_isolation), schreibt nur über die
--   Funktionen unten (SECURITY DEFINER, Policy owner_tenant im Kontext des Mandanten).
-- - Jede Änderung erhöht tenant.acl_version: alle Instanzen laden das Modell der Organisation neu (Rechte inaktiver
--   Module fallen weg).

CREATE TABLE {{schema}}.tenant_module (
  tenant_id      uuid NOT NULL REFERENCES {{schema}}.tenant (id),
  module         text NOT NULL,
  allowed        boolean NOT NULL,
  active         boolean NOT NULL,
  active_since   timestamptz,          -- letztes Aktivieren (für `nachholen`)
  inactive_since timestamptz,          -- letztes Deaktivieren
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     uuid,                 -- principal.id; leer = Betrieb (Befehlszeile, Plattform-Administration, Abgleich)
  PRIMARY KEY (tenant_id, module),
  CONSTRAINT tenant_module_key_check CHECK (module ~ '^[a-z][a-z0-9-]{1,30}([.][a-z][a-z0-9-]{1,30})?$'),
  CONSTRAINT tenant_module_active_check CHECK (NOT active OR allowed)
);
CREATE TRIGGER tenant_module_acl_version AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.tenant_module
  FOR EACH ROW EXECUTE FUNCTION app.bump_acl_version();

SELECT app.secure_tenant_tables();
REVOKE INSERT, UPDATE, DELETE ON {{schema}}.tenant_module FROM {{app}};
CREATE POLICY owner_tenant ON {{schema}}.tenant_module TO {{owner}} USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());

-- Freigeben bzw. entziehen (Betrieb): im Kontext des Mandanten p_tenant (gesetzt nur für diesen Aufruf). Entziehen
-- deaktiviert mit. Liefert den Stand vorher und nachher (vorher NULL: keine Zeile).
CREATE FUNCTION app.set_module_allowed(p_tenant uuid, p_module text, p_allowed boolean)
RETURNS TABLE (allowed_before boolean, active_before boolean, allowed boolean, active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
#variable_conflict use_column
DECLARE prev text := coalesce(current_setting('app.tenant_id', true), ''); r record;
BEGIN
  IF p_tenant IS NULL OR p_allowed IS NULL THEN RAISE EXCEPTION 'Mandant und Wert sind Pflicht' USING ERRCODE = '22004'; END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT m.allowed, m.active INTO r FROM {{schema}}.tenant_module m WHERE m.tenant_id = p_tenant AND m.module = p_module FOR UPDATE;
  allowed_before := r.allowed; active_before := r.active;
  INSERT INTO {{schema}}.tenant_module AS m (tenant_id, module, allowed, active, inactive_since, changed_by)
    -- Teilfunktion ohne Zeile war mit ihrem Modul aktiv: Entziehen zählt als Deaktivieren (später nachholen statt einrichten)
    VALUES (p_tenant, p_module, p_allowed, false, CASE WHEN position('.' IN p_module) > 0 THEN now() END, NULL)
    ON CONFLICT (tenant_id, module) DO UPDATE SET
      allowed = excluded.allowed,
      active = m.active AND excluded.allowed,
      inactive_since = CASE WHEN m.active AND NOT excluded.allowed THEN now() ELSE m.inactive_since END,
      changed_at = now(), changed_by = NULL
    RETURNING m.allowed, m.active INTO allowed, active;
  PERFORM set_config('app.tenant_id', prev, true);
  RETURN NEXT;
END $$;

-- Aktivieren bzw. deaktivieren (Organisation): im Kontext des Mandanten, nur erlaubte Module (sonst 42501). Teilfunktionen
-- ohne eigene Zeile sind erlaubt, wenn ihr Modul erlaubt ist. Liefert den Stand vorher und nachher.
CREATE FUNCTION app.set_module_active(p_module text, p_active boolean)
RETURNS TABLE (active_before boolean, active_since_before timestamptz, inactive_since_before timestamptz, active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
#variable_conflict use_column
DECLARE v_tenant uuid := app.tenant_id(); r record; v_allowed boolean;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Kein Mandant im Kontext' USING ERRCODE = '42501'; END IF;
  IF p_active IS NULL THEN RAISE EXCEPTION 'Wert ist Pflicht' USING ERRCODE = '22004'; END IF;
  SELECT m.allowed, m.active, m.active_since, m.inactive_since INTO r FROM {{schema}}.tenant_module m WHERE m.tenant_id = v_tenant AND m.module = p_module FOR UPDATE;
  v_allowed := r.allowed;
  IF v_allowed IS NULL AND position('.' IN p_module) > 0 THEN
    SELECT m.allowed INTO v_allowed FROM {{schema}}.tenant_module m WHERE m.tenant_id = v_tenant AND m.module = split_part(p_module, '.', 1);
  END IF;
  IF p_active AND NOT coalesce(v_allowed, false) THEN
    RAISE EXCEPTION 'Modul % ist für diese Organisation nicht freigegeben', p_module USING ERRCODE = '42501';
  END IF;
  active_before := coalesce(r.active, position('.' IN p_module) > 0 AND v_allowed IS TRUE);
  active_since_before := r.active_since; inactive_since_before := r.inactive_since;
  INSERT INTO {{schema}}.tenant_module AS m (tenant_id, module, allowed, active, active_since, inactive_since, changed_by)
    VALUES (v_tenant, p_module, coalesce(v_allowed, false), p_active, CASE WHEN p_active THEN now() END, CASE WHEN NOT p_active THEN now() END, app.principal_id())
    ON CONFLICT (tenant_id, module) DO UPDATE SET
      active = excluded.active,
      active_since = CASE WHEN excluded.active AND NOT m.active THEN now() ELSE m.active_since END,
      inactive_since = CASE WHEN m.active AND NOT excluded.active THEN now() ELSE m.inactive_since END,
      changed_at = now(), changed_by = app.principal_id()
    RETURNING m.active INTO active;
  RETURN NEXT;
END $$;

-- Erste Belegung einer Organisation ohne Zeilen (Abgleich nach den Migrationen, Sicherheitsnetz beim Laden): alle
-- genannten Module erlaubt und aktiv. Nur, solange der Mandant keine Zeile hat; liefert die Zahl der angelegten Zeilen.
CREATE FUNCTION app.backfill_modules(p_modules text[]) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
DECLARE v_tenant uuid := app.tenant_id(); n int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Kein Mandant im Kontext' USING ERRCODE = '42501'; END IF;
  -- Gleichzeitige Aufrufe für denselben Mandanten nacheinander (die zweite sieht danach die Zeilen)
  PERFORM pg_advisory_xact_lock(hashtext('iam-module-backfill'), hashtext(v_tenant::text));
  IF EXISTS (SELECT 1 FROM {{schema}}.tenant_module WHERE tenant_id = v_tenant) THEN RETURN 0; END IF;
  INSERT INTO {{schema}}.tenant_module (tenant_id, module, allowed, active, active_since)
    SELECT v_tenant, k, true, true, now() FROM unnest(p_modules) AS k GROUP BY k;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION app.set_module_allowed(uuid, text, boolean), app.set_module_active(text, boolean), app.backfill_modules(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_module_allowed(uuid, text, boolean), app.set_module_active(text, boolean), app.backfill_modules(text[]) TO {{app}};
