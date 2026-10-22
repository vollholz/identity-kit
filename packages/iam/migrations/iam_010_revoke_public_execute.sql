-- iam_010 Kein EXECUTE für PUBLIC auf Funktionen in app und {{schema}} (Spezifikation Kap. 10.1; aus Assets 051).
--
-- iam_007 entzieht die Standardrechte erst für neue Funktionen. Ältere Funktionen (app.tenant_id, app.principal_id,
-- app.secure_tenant_tables, app.audit_hash, app.audit_chain) waren noch für PUBLIC ausführbar. Nicht ausnutzbar,
-- PUBLIC hat keine USAGE auf app, aber Tiefenverteidigung: ausführen darf nur, wem es ausdrücklich gegeben ist.
-- - Idempotent über alle Funktionen und Prozeduren beider Schemas; was schon entzogen ist, bleibt unverändert.
-- - {{app}} und {{sched}} behalten ihre ausdrücklichen Rechte (tenant_id, principal_id, Entra-Funktionen usw.).
-- - Nur über PUBLIC lief bisher app.audit_hash: Prüfung der Audit-Kette und app.audit_chain(), die im Trigger mit den
--   Rechten der einfügenden Rolle läuft. Beide Rollen erhalten EXECUTE ausdrücklich.
-- - Trigger-Funktionen (app.audit_chain, app.bump_acl_version) brauchen beim Auslösen kein EXECUTE, nur beim Anlegen
--   des Triggers (Besitzer-Rolle).
-- - app.secure_tenant_tables ruft nur der Migrations-Runner als Besitzer-Rolle auf.

REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA app, {{schema}} FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit_hash(bytea, {{schema}}.audit_log) TO {{app}}, {{sched}};
