-- iam_016 Zuständigkeit über Personen aus Fachdaten (Kit 1.1; Spezifikation Kap. 7.5 Regel 2, 7.6, 7.7
-- `ResourceModel.edges.persons`): Die App deklariert je Ressource zuständige Personen (Assets: Attribut «Verantwortlich»
-- der Art user mit grants). Lesesicht: app.read_person() bzw. app.write_person() liefern principal.id der anfragenden
-- Person, wenn der Scope das Lese- bzw. Schreibrecht des Typs mit Zuständigkeit deckt; sonst (Client, Scope fehlt, keine
-- Einstellung) NULL – ein Vergleich mit NULL ergibt nie eine Zeile.
CREATE FUNCTION app.read_person() RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT nullif(current_setting('app.read_person', true), '')::uuid $$;
CREATE FUNCTION app.write_person() RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
  $$ SELECT nullif(current_setting('app.write_person', true), '')::uuid $$;
REVOKE EXECUTE ON FUNCTION app.read_person(), app.write_person() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_person(), app.write_person() TO {{app}};
