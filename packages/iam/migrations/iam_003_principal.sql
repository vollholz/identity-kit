-- iam_003 Principals (Spezifikation Kap. 6.2, 9.3; aus Assets 001, 014, 016, 045): Spiegel der Personen und
-- Maschinen-Clients je Mandant, für Audit, Zugriffsregeln, Personenverzeichnis und Verwaltung.
--
-- - Eigene ID je Mandant; dieselbe Person hat in jedem Mandanten eine andere ID.
-- - last_seen_at NULL: Mitglied aus dem Abgleich, noch nie zugegriffen.
-- - removed_at: aus der Organisation entfernt (Verweise und Audit bleiben). Ein Token gilt danach nur, wenn es nach
--   removed_at ausgestellt wurde.
-- - last_roles, last_scopes: nur Maschinen-Clients, Rollen und Scopes aus dem zuletzt gesehenen Token (Verwaltung).

CREATE TABLE {{schema}}.principal (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('user', 'client')),
  subject text NOT NULL,
  display_name text,
  email text,
  client_id text,
  last_seen_at timestamptz DEFAULT now(),
  removed_at timestamptz,
  last_roles text[],
  last_scopes text[],
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, kind, subject)
);
-- Sortierung nach Name (ohne Gross/Klein) mit stabiler Cursor-Paginierung über (Name, ID)
CREATE INDEX principal_name_sort ON {{schema}}.principal (tenant_id, kind, lower(coalesce(display_name, '')), id);
