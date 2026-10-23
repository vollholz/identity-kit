-- iam_006 Sitzungen der Oberfläche (BFF) und geteilter Zustand (Spezifikation Kap. 5.2, 6.1).
--
-- session: `id` ist der SHA-256-Hash der Sitzungs-ID aus dem Cookie, nie die ID selbst; `data` verschlüsselt
-- (AES-256-GCM, AAD = Sitzungs-ID). `subject` und `idp_sid` für den Backchannel-Logout. Kein Mandantenbezug, ohne RLS.
-- replay_guard, rate_limit: kurzlebig (UNLOGGED, nach einem Absturz leer), ohne Mandantendaten.

CREATE TABLE {{schema}}.session (
  id text PRIMARY KEY,
  data bytea NOT NULL,           -- verschlüsselt (Tokens, Person, Organisationen)
  csrf text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  subject text,                  -- `sub` der Person
  idp_sid text                   -- `sid` der Keycloak-Sitzung
);
CREATE INDEX session_expiry ON {{schema}}.session (expires_at);
CREATE INDEX session_subject ON {{schema}}.session (subject);
CREATE INDEX session_idp_sid ON {{schema}}.session (idp_sid) WHERE idp_sid IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.session TO {{app}};

CREATE UNLOGGED TABLE {{schema}}.replay_guard (
  key text PRIMARY KEY,           -- z. B. «dpop:<jkt>:<jti>» oder «bcl:<jti>»
  expires_at timestamptz NOT NULL
);
CREATE INDEX replay_guard_expiry ON {{schema}}.replay_guard (expires_at);

CREATE UNLOGGED TABLE {{schema}}.rate_limit (
  key text PRIMARY KEY,           -- «<route>|<tenant>:<principal>» oder «<route>|<ip>»
  hits int NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX rate_limit_expiry ON {{schema}}.rate_limit (reset_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.replay_guard, {{schema}}.rate_limit TO {{app}};
