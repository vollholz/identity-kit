-- iam_003 Principals (Spezifikation Kap. 6.2, 7.8, 9.3, 9.6): Spiegel der Personen und Maschinen-Clients je Mandant.
--
-- - Eigene ID je Mandant; dieselbe Person hat in jedem Mandanten eine andere ID. Subjekte der Tupel:
--   `user:<id>` bzw. `client:<id>`.
-- - Personen: `subject` = Keycloak-ID. Maschinen-Clients: `subject` = `client_id` (Client-ID der Freigabe); der
--   Principal entsteht spätestens mit der Freigabe (A18), eindeutig je Mandant und Client-ID.
-- - last_seen_at NULL: noch nie zugegriffen (Abgleich, Einladung, Freigabe). removed_at: aus der Organisation entfernt
--   (Verweise und Audit bleiben); ein Token gilt danach nur, wenn es nach removed_at ausgestellt wurde.
-- - clearance: gespeicherte Freigabestufe; Break-Glass hebt sie befristet (clearance_boost bis clearance_until).
--   Änderungen erhöhen acl_version (sofort auf allen Instanzen).
-- - last_scopes: nur Clients, Scopes aus dem letzten Token. description, created_by_name: nur Clients.

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
  last_scopes text[],
  clearance smallint NOT NULL DEFAULT 0 CHECK (clearance BETWEEN 0 AND 2),
  clearance_boost smallint CHECK (clearance_boost BETWEEN 0 AND 2),
  clearance_until timestamptz,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_name text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, kind, subject),
  CONSTRAINT principal_clearance_boost CHECK ((clearance_until IS NULL) = (clearance_boost IS NULL)),
  CONSTRAINT principal_client_id CHECK (kind <> 'client' OR (client_id = subject AND client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'))
);
CREATE UNIQUE INDEX principal_client ON {{schema}}.principal (tenant_id, client_id) WHERE kind = 'client';
-- Sortierung nach Name (ohne Gross/Klein) mit stabiler Cursor-Paginierung über (Name, ID)
CREATE INDEX principal_name_sort ON {{schema}}.principal (tenant_id, kind, lower(coalesce(display_name, '')), id);
CREATE TRIGGER principal_clearance_version AFTER UPDATE OF clearance, clearance_boost, clearance_until ON {{schema}}.principal
  FOR EACH ROW WHEN (OLD.clearance IS DISTINCT FROM NEW.clearance OR OLD.clearance_boost IS DISTINCT FROM NEW.clearance_boost OR OLD.clearance_until IS DISTINCT FROM NEW.clearance_until)
  EXECUTE FUNCTION app.bump_acl_version();
