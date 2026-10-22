-- iam_011 Mandanten-Auflösung strenger (Spezifikation Kap. 4; Befunde aus dem Review von identity-kit#10).
--
-- 1. Nur ASCII-Aliasse: Die Eingabe wird roh gegen das Muster geprüft und nur A–Z wird klein (translate). lower()
--    faltete in einer Unicode-Locale auch andere Zeichen (Kelvin-Zeichen U+212A → «k»), so fand ein ungültiger Alias
--    einen fremden Mandanten. Ungültig → NULL, nichts angelegt. Die API prüft dasselbe vorher (ALIAS_PATTERN); dies
--    ist die Absicherung in der Datenbank.
-- 2. Binden der Organisations-ID: Gehört die ID aus dem Token schon einem anderen Mandanten, bleibt das Binden
--    wirkungslos – dann gilt der Mandant nicht als aufgelöst (NULL), statt trotzdem seine ID zu liefern. Massgeblich
--    ist die ID nach dem Versuch (auch bei gleichzeitigem ersten Kontakt derselben Organisation).

CREATE OR REPLACE FUNCTION app.resolve_tenant(p_alias text, p_kc_org_id text, p_name text, p_create boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = {{schema}}, pg_temp AS $$
DECLARE v_id uuid; v_status text; v_kc text; v_alias text;
BEGIN
  IF p_alias IS NULL OR p_alias !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$' THEN RETURN NULL; END IF;
  v_alias := translate(p_alias, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
  SELECT id, status, kc_org_id INTO v_id, v_status, v_kc FROM {{schema}}.tenant WHERE alias = v_alias;
  IF v_id IS NULL AND p_create THEN
    INSERT INTO {{schema}}.tenant (alias, kc_org_id, name) VALUES (v_alias, p_kc_org_id, coalesce(p_name, p_alias))
      ON CONFLICT (alias) DO UPDATE SET alias = excluded.alias RETURNING id, status, kc_org_id INTO v_id, v_status, v_kc;
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
