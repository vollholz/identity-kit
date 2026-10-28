# Pakete des Baukastens in einer App

Gilt für jedes Paket `@vollholz/*` (Test-Kit, Backend, Frontend).

## Bezug

- `.npmrc` der App, ohne Token: `@vollholz:registry=https://npm.pkg.github.com`
- Versionen exakt pinnen (`"@vollholz/iam-testkit": "0.1.0"`), Renovate hält sie aktuell.
- Die Pakete sind öffentlich auf GitHub Packages. Die npm-Registry von GitHub verlangt trotzdem eine Anmeldung: Jedes
  GitHub-Konto genügt, eine Mitgliedschaft in `vollholz` oder ein Zugang zum Repository ist nicht nötig.

## CI (GitHub Actions)

```yaml
permissions:
  contents: read
  packages: read
env:
  NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # auf Jobebene: auch npm audit signatures fragt die Registry
  # Reicht GITHUB_TOKEN in einem Repository ausserhalb von vollholz nicht (403): ein persönliches Token (classic) mit
  # nur read:packages als Secret nehmen (kein Maschinenkonto nötig): NODE_AUTH_TOKEN: ${{ secrets.NPM_READ_TOKEN }}
steps:
  - uses: actions/setup-node@v7.0.0
    with:
      node-version-file: .nvmrc
      registry-url: https://npm.pkg.github.com
      scope: "@vollholz"
  - run: npm ci
```

## Image

```dockerfile
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```

In der CI eine Datei mit `//npm.pkg.github.com/:_authToken=<GITHUB_TOKEN>` schreiben und als `secret-files:
npmrc=…` an `docker/build-push-action` geben; lokal `docker build --secret id=npmrc,src=$HOME/.npmrc .`. Das Secret
ist nur während `npm ci` gemountet und nie im Image.

## Lokal

Einmalig ein persönliches Token (classic) mit nur `read:packages` (beliebiges GitHub-Konto) in die eigene `~/.npmrc`:
`//npm.pkg.github.com/:_authToken=<token>`. CI ausserhalb von GitHub Actions: ebenso, das Token als Secret der CI.

## Ohne Zugang (Sessions, unveröffentlichter Stand)

```bash
node scripts/local-registry.ts           # in identity-kit: baut, packt und liefert @vollholz/* auf 127.0.0.1:4873
env 'npm_config_@vollholz:registry=http://127.0.0.1:4873/' npm ci      # in der App
```

Die lokal gepackten Pakete sind nicht byte-gleich mit den veröffentlichten. Deshalb: Einträge `@vollholz/*` im
`package-lock.json` ohne `resolved` und `integrity` committen (npm holt sie dann über die Registry aus `.npmrc`);
die Integrität trägt das nächste `npm install` mit echtem Zugang nach.

## Neue Version

Version in `packages/<paket>/package.json` erhöhen, den Abschnitt der Version in `packages/<paket>/CHANGELOG.md`
schreiben und per PR mergen. Der Workflow «Release» veröffentlicht nach dem Merge jedes Paket, dessen Version noch nicht
in der Registry liegt, setzt das Tag `<paket>-v<version>` und legt ein GitHub Release mit dem Abschnitt als Text an.
Versionen je Paket (semantisch, Breaking = Major).

**Keine neue Version ohne CHANGELOG-Eintrag.** Abschnitt `## [<version>] – <datum>` zuoberst (unter «Unveröffentlicht»),
darin nach Bedarf `### Breaking`, `### Hinzugefügt`, `### Geändert`, `### Entfernt`, `### Behoben`. Unter Breaking steht
jede Änderung, die eine App anpassen muss, mit Migrationsschritten. Die CI prüft das (`node scripts/changelog.ts
check`); ohne Abschnitt bricht auch «Release» vor dem Veröffentlichen ab. Apps lesen vor dem Anheben die Abschnitte
zwischen ihrer und der neuen Version (CHANGELOG.md im Paket oder GitHub Releases `<paket>-v<version>`).

OpenTofu-Module: Version in `modules/<modul>/VERSION` erhöhen und per PR mergen; «Release» setzt dann das Tag
`<modul>-v<version>`. Die App bezieht das Modul über
`source = "git::https://github.com/vollholz/identity-kit.git//modules/<modul>?ref=<modul>-v<version>"`.

## Umstieg auf `@vollholz/iam` 5.0 (`@vollholz/iam-web` 2.2, `@vollholz/platform` 0.6)

Eigene Rollen der Organisation (O17). Vollständig: [packages/iam/CHANGELOG.md](../packages/iam/CHANGELOG.md) (5.0.0),
[packages/iam-web/CHANGELOG.md](../packages/iam-web/CHANGELOG.md) (2.2.0). Kurz:

- **Recht `roles:admin`** kommt ins Modell (org-admin hat es). Tests mit genauen Rechtelisten anpassen oder eigene Rollen
  abschalten: `defineModel({ …, features: { customRoles: false } })`.
- **Migration `iam_019`** (Tabelle `authz_role`, RLS, Trigger) läuft mit dem nächsten `migrate`; RLS-Matrizen der App um
  `authz_role` (Tabelle des Baukastens) und ihre Policy `owner_tenant` ergänzen.
- **Neue Routen** `/v1/admin/roles…` und `/v1/platform/organizations/{alias}/roles…` in den Isolations-Durchlauf aufnehmen.
- **Oberfläche:** Route `roles` (`paths.roles`, `/verwalten/rollen`) einhängen, wenn die App Routen nicht aus
  `iamRoutes` baut. Policies der App bleiben unverändert (die Lesesicht kennt die eigenen Rollen).

## Umstieg auf `@vollholz/iam` 4.0 (`@vollholz/platform` 0.5)

Vollständig mit allen Schritten: [packages/iam/CHANGELOG.md](../packages/iam/CHANGELOG.md) (4.0.0) und
[packages/platform/CHANGELOG.md](../packages/platform/CHANGELOG.md) (0.5.0). Kurz:

- **`events` ist ein Objekt** `{ before?, after? }` statt einer Funktion `(tx, type, subject, data)`. Die alte Funktion
  rief das Paket nie auf; wer sie übergab, schreibt `events: { after: async (tx, e) => alt(tx, e.type, e.subject, e.data) }`
  oder lässt sie weg.
- **`after` erhält ab jetzt Ereignisse:** `access.granted`, `access.revoked`, `access.expired` je Rolle an einem Ort
  (auch für Aufrufe der App über `iam.tuples`), `member.removed`, `member.left`. Eigene `access.changed` der App (O10)
  entfallen oder werden aus diesen gebildet, sonst doppelt.
- **Ablehnen beim Entfernen:** `before` mit `member.removing` gilt für die Verwalten-Seiten und `iam.admin.removeMember`
  gleichermassen; ein geworfenes `HttpError` geht als problem+json zurück.
- **Worker:** dieselben Haken an `MemberSync` geben (`@vollholz/platform`: `AppSpec.iamEvents`, wirkt überall).
- **TLS:** `migrate`, `iam-org-bootstrap`, `iam-reset` sowie `migrate`, `tenant` und `rotate-keys` der Plattform halten
  `DATABASE_SSL` ein. Wer dort bisher `verify-full` setzte, ohne dass das Zertifikat prüfbar ist, setzt die CA bzw.
  `require`.
- **Test-Kit 2.2:** unterstütztes Fenster für `@vollholz/iam` ab 3.0.0 (aktuelle und vorherige Hauptversion).

## Umstieg auf `@vollholz/iam` 3.0 und `@vollholz/iam-web` 2.0

Brechende Änderungen (Konto ohne Organisation, Spezifikation [6.3](spezifikation.md#63-konto-ohne-organisation)):

- **Plattform-Administration ohne Organisation:** `platform-admin` braucht keine Mitgliedschaft mehr und gibt in einer
  Organisation keine Rechte (auch nicht `org-admin` über `POST /v1/access`). Betrieb und Organisation mit getrennten
  Konten: `iam-org-bootstrap --operator --email …` bzw. `operators` in `init.json`; `--platform-admin` und
  `platformAdmin` je Admin entfallen (Abbruch bzw. Fehler im Schema). Im Manifest `identity.app.json` (Test-Kit 2.0)
  steht der Betrieb unter `operators`; `create-iam-app init --operator <e-mail>` trägt ihn ein.
- **Protokoll:** Aktionen der Plattform stehen zusätzlich in `platform_audit_log` (Migration `iam_017_account.sql`);
  `actorTenant` entfällt in den Daten des Audits.
- **`TENANT_AUTO_PROVISION`:** Standard `false`, in Produktion ein Fehler der Konfiguration. Tests und lokale
  Entwicklung setzen es ausdrücklich, wenn sie Mandanten über das Token anlegen.
- **Neue Variablen** der App-Konfiguration (Obermenge von `IAM_VARS`): `SELF_SERVICE_SIGNUP`, `SELF_SERVICE_ORGS`,
  `SELF_SERVICE_ORG_LIMIT`, `RESERVED_ALIASES` (`selfService` in `IamConfig`).
- **Neue Routen** im Modul `account`: `GET /v1/account`, `POST /v1/account/organizations`, öffentlich `POST /v1/signup`
  (in die Prüfung auf Mandantentrennung der App aufnehmen). Eigene Routen ohne Organisation mit
  `config: { iam: { contexts: ['account'] } }`.
- **Oberfläche:** Ohne Organisation zeigt die Sitzung das Konto (wählen, eigene Organisation erstellen, Plattform);
  `RequiresPlatformAdmin` und die Navigation lesen `GET /v1/account`; neuer Pfad `paths.signup` und Schalter
  `features.signup`. Testhilfe `mockIamApi` liefert `GET /v1/account` (`accountInfo()`).
