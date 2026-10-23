-- iam_014 Anmeldung über Microsoft Entra ID mit eigener App der Organisation (Spezifikation Kap. 9.4, Kit 0.3; aus Assets
-- #22 «Eigene App», dort Migration 050, in Assets nicht gemergt).
--
-- Statt der mandantenfähigen App der Plattform (ENTRA_CLIENT_ID) registriert die Organisation eine App in ihrem eigenen
-- Tenant und trägt Anwendungs-ID und Geheimnis ein. Dieselbe App meldet Personen in Keycloak an (Anbieter «microsoft»,
-- Prinzipal = Objekt-ID) und liest über Microsoft Graph Organisation, Domänen und Personen.
--
-- entra_connection:
-- - app_client_id: Anwendungs-ID der eigenen App; NULL = App der Plattform.
-- - app_secret_enc: Geheimnis, verschlüsselt mit ENCRYPTION_KEYS (AES-256-GCM, `v1.<keyId>.<iv>.<tag>.<ct>`, AAD an
--   Mandant und Anwendungs-ID gebunden; Rotation: rewrapEntraSecrets). Nie im Klartext, nie in einer Antwort.
-- - app_secret_expires_at: Ablauf des Geheimnisses, wenn bekannt (aus Graph oder bei der Eingabe angegeben).
-- - idp_alias: zusätzlich `entra-app-<alias der Organisation>` – die Redirect-URI steht vor dem Verbinden fest (Plätze
--   `entra-NNN` gelten nur für die App der Plattform).
-- entra_consent_link.kind: `consent` (Zustimmung bei Microsoft über die App der Plattform) oder `credentials` (die
-- Kunden-IT trägt die eigene App ein, ohne Konto in der App).

ALTER TABLE {{schema}}.entra_connection
  ADD COLUMN app_client_id uuid,
  ADD COLUMN app_secret_enc text CHECK (length(app_secret_enc) <= 4000),
  ADD COLUMN app_secret_expires_at timestamptz,
  ADD CONSTRAINT entra_connection_app CHECK ((app_client_id IS NULL) = (app_secret_enc IS NULL)),
  DROP CONSTRAINT entra_connection_idp_alias_check,
  ADD CONSTRAINT entra_connection_idp_alias_check CHECK (idp_alias ~ '^entra-([0-9]{3}|app-[a-z0-9][a-z0-9_-]{0,62})$');

ALTER TABLE {{schema}}.entra_consent_link
  ADD COLUMN kind text NOT NULL DEFAULT 'consent' CHECK (kind IN ('consent', 'credentials'));
