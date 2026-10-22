-- iam_005 Einladungen und Freigaben von Maschinen-Clients (Spezifikation Kap. 9.1, 12.1; aus Assets 020, 043, 047).
--
-- member_invitation: offene Einladungen je Mandant. Nach aussen trägt eine eingeladene Person die eigene ID der
-- Einladung (neu je Einladung), nie die ID ihres Kontos in Keycloak (`user_id`). `created_account`: diese Einladung hat
-- das Konto angelegt – nur dann löscht das Zurückziehen ein nie benutztes Konto. `entra`: über Microsoft Entra ID vorab
-- angelegt, angenommen mit dem ersten Zugriff.
-- client_grant: Ein Token eines Maschinen-Clients gilt nur in Mandanten, in denen seine Client-ID freigegeben ist –
-- gleich, welche Organisation ein Mapper in Keycloak in das Token schreibt.

CREATE TABLE {{schema}}.member_invitation (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  user_id text NOT NULL,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_name text,
  accepted_at timestamptz,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_account boolean NOT NULL DEFAULT false,
  entra boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT member_invitation_id UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX member_invitation_email ON {{schema}}.member_invitation (tenant_id, lower(email)) WHERE accepted_at IS NULL;

CREATE TABLE {{schema}}.client_grant (
  tenant_id uuid NOT NULL REFERENCES {{schema}}.tenant(id),
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_name text,
  PRIMARY KEY (tenant_id, client_id)
);
