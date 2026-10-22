# Assets infra/keycloak (3a148ae)

Unveränderte Kopie aus vollholz/assets `main` (`3a148ae`): `infra/keycloak/*.tf`, `lookup.ts`, `org-mapper.ts`,
`platform.json`, `localization-*.json`, Lockfile und `bootstrap/main.tf`. Nicht kopiert: `backend.hcl`, `kc.sh`,
`smtp-test.ts`, `platform.ts`, `keys/` (keycloak.sh setzt Testschlüssel ein und ersetzt das Backend durch ein lokales).

Dient `../../keycloak.sh` als «heutiger Stand» für den Nachweis, dass das Modul denselben Realm ergibt. Nach der
Umstellung von Assets (Phase 2) entfällt der Nachweis gegen diesen Stand.
