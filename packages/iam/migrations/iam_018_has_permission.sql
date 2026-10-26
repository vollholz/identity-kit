-- iam_018 Bestimmtes Recht in Policies prüfen (Kit 3.2; Spezifikation Kap. 7.6): app.has_permission(Recht) und
-- app.has_permission(Recht, Typ, ID). Die Lesesicht des Blatts (app.read_all(), app.read_relations() …) folgt dem
-- Leserecht des Typs; Tabellen, die ein eigenes, engeres Recht verlangen (z. B. Gesundheitsdaten einer Person), prüfen
-- damit genau dieses Recht – eine Rolle mit breitem Leserecht an org genügt dann nicht.
--
-- - has_permission(p): Recht gilt an org (Rollen an org ∩ Scope, app.org_permissions), wie app.read_all_of(p).
-- - has_permission(p, typ, id): an org oder über ein nicht abgelaufenes Tupel eines Subjekts der Anfrage an genau
--   dieser Ressource mit einer Relation, die das Recht enthält (∩ Scope, app.relations_of(p); bei owner-Typen auch
--   owner). Rollen an Vorfahren und Zuständigkeit (Einheiten, Personen) zählen nicht: dafür app.read_types(),
--   app.read_units(), app.person_for(p) oder ein weiterer Aufruf für den Elternort.
-- - Ohne Einstellung (keine Anfrage, Recht unbekannt, Scope deckt es nicht): false. Volle Sicht (fullView): true.
-- - STABLE, SECURITY INVOKER, search_path fest, EXECUTE nur für {{app}} (wie die übrigen Funktionen der Lesesicht).

CREATE FUNCTION app.has_permission(p_permission text) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT coalesce(p_permission = ANY (coalesce(nullif(current_setting('app.org_permissions', true), '')::text[], '{}')), false) $$;
CREATE FUNCTION app.has_permission(p_permission text, p_object_type text, p_object_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT app.has_permission(p_permission) OR coalesce(app.has_tuple(p_object_type, p_object_id, app.relations_of(p_permission)), false)
$$;
REVOKE EXECUTE ON FUNCTION app.has_permission(text), app.has_permission(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.has_permission(text), app.has_permission(text, text, uuid) TO {{app}};
