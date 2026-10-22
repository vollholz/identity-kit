# Pakete des Baukastens in einer App

Gilt für jedes Paket `@vollholz/*` (Test-Kit, Backend, Frontend). Referenz: vollholz/assets (PR #23).

## Bezug

- `.npmrc` der App, ohne Token: `@vollholz:registry=https://npm.pkg.github.com`
- Versionen exakt pinnen (`"@vollholz/iam-testkit": "0.1.0"`), Renovate hält sie aktuell.
- Das Paket gibt der App Lesezugriff: Paket › Package settings › Manage Actions access › Repository hinzufügen
  (gleiche Organisation). Repositories anderer Organisationen: Maschinenkonto mit Leserecht auf dem Paket und
  Token (classic) mit `read:packages` als Secret.

## CI (GitHub Actions)

```yaml
permissions:
  contents: read
  packages: read
env:
  NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # auf Jobebene: auch npm audit signatures fragt die Registry
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

Einmalig ein persönliches Token (classic) mit `read:packages` in die eigene `~/.npmrc`:
`//npm.pkg.github.com/:_authToken=<token>`.

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
