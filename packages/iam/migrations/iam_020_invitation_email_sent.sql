-- iam_020 Einladung nicht versendet: Konnte Keycloak die E-Mail einer Einladung nicht senden, bleibt die
-- Einladung offen (zurückziehen, erneut senden), die Person erscheint aber mit Status `not-sent` statt `invited`, bis
-- «Einladung erneut senden» gelingt.
--
-- member_invitation.email_sent: E-Mail der Einladung versendet. Nur Einladungen mit Passwort; Einladungen aus Entra ID
-- (`entra`) bleiben true (angenommen mit dem ersten Zugriff, die E-Mail ist dort nur ein Hinweis).
--
-- Bestand: true, ausser das Protokoll zeigt für genau diese Einladung `member.invited` mit `emailSent: false` und kein
-- späteres `member.invitation_resent`. Dafür gilt die Zeilenrichtlinie für den Besitzer kurz nicht (FORCE in derselben
-- Transaktion zurück, wie iam_012). RLS bleibt wie bisher (Spalte tenant_id).

ALTER TABLE {{schema}}.member_invitation ADD COLUMN email_sent boolean NOT NULL DEFAULT true;

ALTER TABLE {{schema}}.member_invitation NO FORCE ROW LEVEL SECURITY;
ALTER TABLE {{schema}}.audit_log NO FORCE ROW LEVEL SECURITY;
UPDATE {{schema}}.member_invitation i SET email_sent = false
 WHERE i.accepted_at IS NULL AND NOT i.entra
   AND EXISTS (SELECT 1 FROM {{schema}}.audit_log a WHERE a.tenant_id = i.tenant_id AND a.resource_type = 'member' AND a.resource_id = i.id
                  AND a.action = 'member.invited' AND a.data->'emailSent' = 'false'::jsonb)
   AND NOT EXISTS (SELECT 1 FROM {{schema}}.audit_log a WHERE a.tenant_id = i.tenant_id AND a.resource_type = 'member' AND a.resource_id = i.id
                  AND a.action = 'member.invitation_resent');
ALTER TABLE {{schema}}.audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE {{schema}}.member_invitation FORCE ROW LEVEL SECURITY;
