# @vollholz/iam-testkit

Tests für Apps mit dem Baukasten. Spezifikation Kap. 14.

Inhalt: Keycloak-Nachbildung (Admin-API, Tokens), Testpersonen und -organisationen, Isolations-Durchlauf über alle
`/v1`-Routen, RLS-Prüfung, Prüfung des Katalogs (reservierte Namen, Schlüsselregeln, `platform.json`),
Konformitätstests des Vertrags gegen eine laufende App (auch für Apps, die nicht in Node geschrieben sind).

Herkunft: vollholz/assets `test/platform/{harness,keycloak-fake}.ts`, `{auth,bff,admin,authz,capabilities,multi-org,rls,
tenant-isolation,roles}.test.ts`.

Stand: leer. Erster Baustein, der herausgelöst wird.
