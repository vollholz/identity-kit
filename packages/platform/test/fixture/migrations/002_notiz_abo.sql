-- Abo der Notizen (öffentliche Route mit Token, Muster für Kalender-Abos): je Person höchstens ein Token, gespeichert
-- nur als SHA-256. Nur tenant_isolation (keine Lesesicht): Die öffentliche Route sucht das Token im Kontext der
-- Organisation, bevor sie in die Lesesicht der Person wechselt.

CREATE TABLE probe.notiz_abo (
  tenant_id     uuid NOT NULL REFERENCES probe.tenant (id) ON DELETE CASCADE,
  principal_id  uuid NOT NULL,
  token_hash    text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES probe.principal (tenant_id, id)
);
