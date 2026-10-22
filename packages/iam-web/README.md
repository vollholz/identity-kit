# @vollholz/iam-web

Frontend-Baustein (React) des IAM-Baukastens. Spezifikation Kap. 11, Entwurf und Plan: [docs/entwurf.md](docs/entwurf.md).

Inhalt (Ziel 0.1.0): `IamProvider`, Sitzung und `/auth/me`, Organisation je Tab, `useAuthz()`, `useResourceCan()`,
`MissingRight`, Routen-Guards, Rechte-Übersicht, Rollenmatrix, «Meine Rollen und Rechte», Verwalten › Zugang
(Mitglieder, Rollen, Anmeldung, Maschinen-Clients), Zugriff, Organisationen. Kein eigenes Aussehen: CSS-Variablen
`--iam-*` aus den Design-Tokens der App, Texte `iam.*` (de/en) überschreibbar.

Herkunft: vollholz/assets `web/src/auth`, `web/src/shell/{UserMenu,MyRights}.tsx`, `web/src/ui/{MissingRight,
RightsOverview,RoleMatrix,AdminHead,MenuButton,Overlay,Picker,states,org,format}`, `web/src/features/{admin,acl}`.

## Stand (Teil-PR 2c)

| Baustein | Inhalt |
|---|---|
| Vertragstypen (`Me`, `AuthzCatalog`, `Role`, `Member`, `AclEntry`, …) | von Hand, geprüft gegen den Auszug der OpenAPI von Assets (`test/contract.check.ts`) |
| `iamFetch`, `authFetch` | Cookie, `X-Tenant`, `X-CSRF-Token`, problem+json → `ApiError`, 401/403 an die Sitzung |
| `iamMiddleware`, `reportStatus` | Rückkanal für eigene Clients der App (z. B. `api.use(iamMiddleware)` mit `openapi-fetch`) |
| `ApiError`, `describeError`, `fieldErrorText` | einzige Fehlerklasse für den Vertrag |
| `readTabOrg`, `writeTabOrg`, `tabOrgFor`, `adoptLegacyTabOrg` | Organisation je Tab (`iam.tab.org`, mit Person) |
| `t`, `tn`, `configureTexts` | Texte `iam.*` de/en, überschreibbar |
| `fmtDate`, `fmtDateTime`, `relTime`, `fmtNum`, `plural` | Formatierung nach Sprache (`de-CH`) |
| `Register`, `Permission`, `ADMIN_ROLE`, `PLATFORM_ADMIN` | Typ der Rechte der App, reservierte Namen |
| `IamUiProvider`, `useIamUi` | austauschbare Grundkomponenten (`components`: Button, Dialog, Menu, Table, Icon, toast) |
| `Button`, `Modal`, `Confirm`, `Sheet`, `MenuButton`, `MenuItem`, `Table`, `Picker`, `Icon` | Grundkomponenten aus Assets `ui/` (Fokusfalle, Tastatur, gesperrt mit Grund) |
| `Loading`, `SkeletonRows`, `Empty`, `ErrorBox`, `ErrorState`, `NotFound` | Zustände, 404 überall gleich |
| `styles.css` | Regeln aus Assets mit Klassen `iam-*`, Variablen `--iam-*`, alles in `@layer iam` |
| `IamProvider`, `useIam`, `Can` | Sitzung über `/auth/me`: Anmeldung, Auswahlseite, «nicht verfügbar», «Sitzung abgelaufen», `/abgemeldet`, Wechsel, Abmelden; Cache der App beim Wechsel geleert |
| `useAuthz`, `useRoles`, `roleGroupProblems` | Katalog (mit `Accept-Language`) und eigene Rollen; Gruppen der Rollen nach `roleGroups` |
| `useResourceCan`, `useIamFetch`, `iamKeys` | Fähigkeiten je Ressource, Aufrufe an den Vertrag, Abfrageschlüssel |
| `historyRouter`, `IamRouter` | Router-Adapter; ohne Router der App die History-API |
| `@vollholz/iam-web/testing` | `StaticIam`, `mockIamApi`, `CATALOG`, `ME` für Tests der App |

Noch `private`; veröffentlicht wird mit dem letzten Teil-PR.

## Entwicklung

```bash
npm run build -w @vollholz/iam-web       # tsc nach dist, styles.css kopiert
npm run typecheck -w @vollholz/iam-web   # inkl. Vertragsprüfung test/contract.check.ts
npm test -w @vollholz/iam-web            # Vitest (jsdom); package.test.ts braucht den Build
npm run contract:types -w @vollholz/iam-web  # Typen aus test/fixtures/openapi-iam.json neu erzeugen
npm run e2e -w @vollholz/iam-web         # Playwright + axe gegen die Testseite (test/e2e/app)
npm run e2e:dev -w @vollholz/iam-web     # Testseite ansehen: http://localhost:4179
```

In Sessions ohne passenden Playwright-Browser: `IAM_E2E_CHROMIUM=/opt/pw-browsers/chromium npm run e2e -w @vollholz/iam-web`
(nie `playwright install` in der Session).

Den Auszug `test/fixtures/openapi-iam.json` bei Vertragsänderungen aus der OpenAPI von Assets erneuern (Pfade
`/auth/*`, `/v1/authz/catalog`, `/v1/acl*`, `/v1/roles*`, `/v1/admin/*`, `/v1/platform/*`, `/v1/people*` mit den
benutzten Schemas, ohne Beschreibungstexte).
