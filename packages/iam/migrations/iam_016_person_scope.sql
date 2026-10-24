-- iam_016 Zuständigkeit über Personen aus Fachdaten und Version beim Anlegen mit Freigabestufe (Kit 1.1;
-- Spezifikation Kap. 7.5 Regel 2, 7.6, 7.7 `ResourceModel.edges.persons`): Die App deklariert je Ressource zuständige
-- Personen (Assets: Attribut «Verantwortlich» der Art user mit grants). Lesesicht: app.read_person() bzw.
-- app.write_person() liefern principal.id der anfragenden Person, wenn der Scope das Lese- bzw. Schreibrecht des Typs
-- mit Zuständigkeit deckt; sonst (Client, Scope fehlt, keine Einstellung) NULL – ein Vergleich mit NULL ergibt nie eine
-- Zeile.
CREATE FUNCTION app.read_person() RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT nullif(current_setting('app.read_person', true), '')::uuid $$;
CREATE FUNCTION app.write_person() RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT nullif(current_setting('app.write_person', true), '')::uuid $$;
-- Für jeden Typ mit Zuständigkeit: principal.id, wenn der Scope dieses Recht (read oder write des Typs) deckt, sonst NULL
CREATE FUNCTION app.person_for(p_permission text) RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT CASE WHEN p_permission = ANY (coalesce(nullif(current_setting('app.person_permissions', true), '')::text[], '{}'))
    THEN nullif(current_setting('app.person', true), '')::uuid END $$;
REVOKE EXECUTE ON FUNCTION app.read_person(), app.write_person(), app.person_for(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_person(), app.write_person(), app.person_for(text) TO {{app}};

-- Freigabestufe beim Anlegen: Ein Principal, der schon mit clearance > 0 oder mit Break-Glass entsteht, erhöht
-- acl_version wie ein UPDATE (iam_015 kennt nur UPDATE); sonst bliebe die zwischengespeicherte Stufe 0 bis zur nächsten
-- Änderung eines Tupels.
CREATE TRIGGER principal_clearance_insert_version AFTER INSERT ON {{schema}}.principal
  FOR EACH ROW WHEN (NEW.clearance > 0 OR NEW.clearance_until IS NOT NULL)
  EXECUTE FUNCTION app.bump_acl_version();
