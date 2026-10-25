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

Version in `packages/<paket>/package.json` erhöhen und per PR mergen. Der Workflow «Release» veröffentlicht nach dem
Merge jedes Paket, dessen Version noch nicht in der Registry liegt, und setzt das Tag `<paket>-v<version>`.
Versionen je Paket (semantisch); brechende Änderungen mit Migrationshinweis in `docs/`.

OpenTofu-Module: Version in `modules/<modul>/VERSION` erhöhen und per PR mergen; «Release» setzt dann das Tag
`<modul>-v<version>`. Die App bezieht das Modul über
`source = "git::https://github.com/vollholz/identity-kit.git//modules/<modul>?ref=<modul>-v<version>"`.

## Umstieg auf `@vollholz/iam` 3.0 und `@vollholz/iam-web` 2.0

Brechende Änderungen (Konto ohne Organisation, Spezifikation [6.3](spezifikation.md#63-konto-ohne-organisation)):

- **Plattform-Administration ohne Organisation:** `platform-admin` braucht keine Mitgliedschaft mehr und gibt in einer
  Organisation keine Rechte (auch nicht `org-admin` über `POST /v1/access`). Betrieb und Organisation mit getrennten
  Konten: `iam-org-bootstrap --operator --email …` bzw. `operators` in `init.json`; `--platform-admin` und
  `platformAdmin` je Admin entfallen (Abbruch bzw. Fehler im Schema).
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
