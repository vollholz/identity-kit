-- iam_005 Einladungen (Spezifikation Kap. 9.1 Nr. 10, 11).
--
-- member_invitation: offene Einladungen je Mandant. Nach aussen trägt eine eingeladene Person die eigene ID der
-- Einladung (neu je Einladung), nie die ID ihres Kontos in Keycloak (`user_id`). `created_account`: diese Einladung hat
-- das Konto angelegt – nur dann löscht das Zurückziehen ein nie benutztes Konto. `entra`: über Microsoft Entra ID vorab
-- angelegt, angenommen mit dem ersten Zugriff. Die Einladung legt den Principal an (A16); Rollen sind Tupel.

CREATE TABLE {{schema}}.member_invitation (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_name text,
  accepted_at timestamptz,
  created_account boolean NOT NULL DEFAULT false,
  entra boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT member_invitation_id UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX member_invitation_email ON {{schema}}.member_invitation (tenant_id, lower(email)) WHERE accepted_at IS NULL;
