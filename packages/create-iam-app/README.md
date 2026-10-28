# @vollholz/create-iam-app

Gerüst einer App mit dem Identity-Kit (Spezifikation 15.4). Statt zehn Handgriffe nach Anleitung legt es an, was in
jeder App gleich ist, und hält es danach aktuell:

| Was | Wer besitzt es | Wie |
|---|---|---|
| `identity.app.json` (Manifest) | App (Zone «Einstellbar») | einmal angelegt, danach nur von der App geändert |
| verwaltete Dateien: `infra/keycloak/*.tf`, `kc.sh`, `platform.ts`, `bootstrap/main.tf`, Workflows `keycloak.yml` und `identity-conformity.yml`, `docs/identity-kit.md` | Kit (Zone «Fest») | Kopf «Verwaltet von identity-kit», Prüfsumme in `.identity-kit.lock`, `sync` schreibt sie neu |
| Modell `src/authz/model.ts` (Stufe «einfach»), `platform.json`, `db/migrations/`, `.npmrc`, `.nvmrc`, Skripte in `package.json` | App (Zone «App-eigen») | nur angelegt, wenn sie fehlen |

Die verwalteten OpenTofu-Dateien lesen ihre Werte zur Laufzeit aus `identity.app.json` (Produkt, Adressen, Schalter,
Maschinen-Clients, State-Backend). Eine geänderte Einstellung braucht deshalb kein neues Gerüst; ein neues Gerüst gibt es
nur mit einer neuen Version des Kits.

```sh
npx @vollholz/create-iam-app init --product notes --name Notes --url https://notes.example.ch \
    --keycloak https://id.example.ch --entra --admin anna@example.ch --org solutions \
    --state-bucket notes-tofu-state --state-region nbg1 --state-endpoint https://nbg1.your-objectstorage.com
npx create-iam-app keys      # Schlüsselpaare: öffentlich nach infra/keycloak/keys/, privat nach ~/.identity/notes/
npx create-iam-app check     # zeigt, was sync ändern würde (Code 1, wenn etwas)
npx create-iam-app sync      # verwaltete Dateien auf diese Version (nach einem Upgrade); von Hand geänderte nur mit --force
```

- `init` ohne Angaben, wenn `identity.app.json` schon besteht; mit Angaben bricht es dann ab (Einstellungen gehören ins
  Manifest).
- Eine verwaltete Datei, die von Hand geändert wurde oder schon bestand, überschreibt weder `init` noch `sync` ohne
  `--force`; eine Datei, die eine frühere Version verwaltete, löscht `sync` nur unverändert.
- `keys` erzeugt nur, was fehlt (EC P-256, `kid` = JWK-Thumbprint), private Schlüssel 0600 in einem Verzeichnis 0700,
  nie überschrieben. Der öffentliche Schlüssel von `<produkt>-tofu` landet nicht im Repository, sondern geht an den
  Betreiber der Keycloak-Instanz.
- Prüfen, ob die App den Vertrag einhält: `npx iam-conformity-test` aus `@vollholz/iam-testkit`.

Leitfaden für eine neue App: [docs/neue-app.md](../../docs/neue-app.md).

## Änderungen

Ab 0.3.0 stehen alle Änderungen in [CHANGELOG.md](CHANGELOG.md).

- **0.2.3:** Neue Apps erhalten `@vollholz/iam` 3.2.1 und `@vollholz/iam-testkit` 2.1.3 (aus `CURRENT` des
  Test-Kits, nennt `@vollholz/platform` 0.4.0); keine Änderung an Vorlagen.
- **0.2.2:** Neue Apps erhalten `@vollholz/iam-testkit` 2.1.2 (aus `CURRENT` des Test-Kits, nennt `@vollholz/platform`
  0.3.0); keine Änderung an Vorlagen.
- **0.2.1:** Neue Apps erhalten `@vollholz/iam` 3.2.0 und `@vollholz/iam-testkit` 2.1.1 (aus `CURRENT` des
  Test-Kits); keine Änderung an Vorlagen.
- **0.1.0:** Erste Version: `init`, `sync`, `check`, `keys`; Manifest `identity.app.json`, Lock-Datei
  `.identity-kit.lock`; Vorlagen für `product-realm` 2.0.0 und `product-realm-bootstrap` 0.1.1.
