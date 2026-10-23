-- iam_012 Keine doppelten Zugriffsregeln (Spezifikation Kap. 7.1): derselbe Eintrag (Ressource, Subjekt, Recht, Wirkung)
-- höchstens einmal je Mandant. Bestehende Duplikate wirken nicht anders als einer und werden zuerst entfernt (es bleibt
-- der älteste); dafür gilt die Zeilenrichtlinie für den Besitzer kurz nicht (FORCE in derselben Transaktion zurück).

ALTER TABLE {{schema}}.acl_entry NO FORCE ROW LEVEL SECURITY;
DELETE FROM {{schema}}.acl_entry a USING {{schema}}.acl_entry b
 WHERE a.tenant_id = b.tenant_id AND a.resource_type = b.resource_type AND a.resource_id IS NOT DISTINCT FROM b.resource_id
   AND a.principal_type = b.principal_type AND a.principal_ref = b.principal_ref AND a.permission = b.permission AND a.effect = b.effect
   AND (a.created_at, a.id) > (b.created_at, b.id);
ALTER TABLE {{schema}}.acl_entry FORCE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX acl_entry_unique ON {{schema}}.acl_entry
  (tenant_id, resource_type, resource_id, principal_type, principal_ref, permission, effect) NULLS NOT DISTINCT;
