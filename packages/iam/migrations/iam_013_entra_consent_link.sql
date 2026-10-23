-- iam_013 Zustimmung über einen Link an die Entra-Administration (Spezifikation Kap. 9.4, Kit 0.2).
--
-- Die org-admin erzeugt einen Link, den eine andere Person der Kunden-IT ohne Sitzung öffnet und bei Microsoft zustimmt.
-- entra_consent_link: Link je Mandant, das Token nur als SHA-256, gebunden an den verlangten Entra-Tenant; einmal
-- einlösbar (used_at), widerrufbar (revoked_at), läuft ab (expires_at, höchstens 24 Stunden). Die erzeugende Person
-- steht dabei (Audit, Akteur der Verbindung); Ergebnis und Fehler für die Anzeige.
-- entra_consent.link_id: Zustimmungen über einen Link haben keine startende Person (subject leer).

CREATE TABLE {{schema}}.entra_consent_link (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  entra_tenant_id uuid NOT NULL,
  platform boolean NOT NULL,
  created_by uuid NOT NULL,              -- Principal der erzeugenden Person (bei der Plattform aus deren Mandant)
  created_by_subject text NOT NULL,
  created_by_name text NOT NULL CHECK (length(created_by_name) <= 256),
  created_by_tenant text NOT NULL,       -- Alias des Mandanten der erzeugenden Person
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at <= created_at + interval '24 hours'),
  used_at timestamptz,
  revoked_at timestamptz,
  approver_name text CHECK (length(approver_name) <= 256),
  error_reason text CHECK (length(error_reason) <= 64),
  error_detail text CHECK (length(error_detail) <= 1000)
);
CREATE INDEX entra_consent_link_created ON {{schema}}.entra_consent_link (tenant_id, created_at DESC);

ALTER TABLE {{schema}}.entra_consent ALTER COLUMN subject DROP NOT NULL;
ALTER TABLE {{schema}}.entra_consent ADD COLUMN link_id uuid REFERENCES {{schema}}.entra_consent_link(id);
ALTER TABLE {{schema}}.entra_consent ADD CONSTRAINT entra_consent_origin CHECK ((subject IS NULL) <> (link_id IS NULL));

SELECT app.secure_tenant_tables();
