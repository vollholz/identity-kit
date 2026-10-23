# @vollholz/iam-web

Oberfläche (React) für Apps mit dem IAM-Baukasten: Sitzung und Organisation je Tab, Rechte-Bausteine, Kontomenü und die
Verwalten-Seiten «Zugang» (Mitglieder, Rollen, Maschinen-Clients, Anmeldung über Microsoft Entra ID, Zugriff,
Organisationen). Vertrag: [Spezifikation](../../docs/spezifikation.md) Kap. 5, 7, 9, 11 und 15; Aufbau und
Entscheide: [docs/entwurf.md](docs/entwurf.md). Herkunft: vollholz/assets `web/src`, produktneutral.

Kein eigenes Aussehen: Das Stylesheet färbt nur über `--iam-*`, die App setzt sie aus ihren Design-Tokens. Alle Texte
(`iam.*`, de und en) lassen sich überschreiben.

## Einbinden

`.npmrc` der App (ohne Token): `@vollholz:registry=https://npm.pkg.github.com`; Zugang mit `read:packages` wie in
[docs/ausrollen.md](../../docs/ausrollen.md). Version exakt pinnen:

```bash
npm i -E @vollholz/iam-web@0.4.0
```

Voraussetzungen der App: `react` und `react-dom` 19, `@tanstack/react-query` 5 (Peer-Abhängigkeiten), ein Server mit
`@vollholz/iam` (BFF unter `/auth/*`, API unter `/v1/…`) an derselben Herkunft; ab iam-web 0.2.0 mit `@vollholz/iam`
0.2.0 oder neuer (Link an die Entra-Administration), für die eigene App-Registrierung (iam-web 0.3.0) mit
`@vollholz/iam` 0.3.0 oder neuer. Mit älteren Servern bleibt es bei der Zustimmung zur App der Plattform. Für Aufgaben
und Voraussetzungen im Rollendialog und `accessTag` (iam-web 0.4.0) braucht es `@vollholz/iam` 0.5.0; ältere Server
liefern sie nicht, dann fehlen Aufgaben und Warnungen, und nur geänderte Rollen und Rechte laden die Daten neu.

| Import | Inhalt |
|---|---|
| `@vollholz/iam-web` | `IamProvider`, Hooks (`useIam`, `useAuthz`, `useResourceCan` …), Rechte-Bausteine, Kontomenü, Grundkomponenten, `iamRoutes`, `IamNav`, `AclHint`, `PersonName`, Client (`iamFetch`, `iamMiddleware`) |
| `@vollholz/iam-web/pages` | Verwalten-Seiten ohne Guard (`MembersPage` …) und mit Guard (`MembersScreen` …), per `lazy()` geladen |
| `@vollholz/iam-web/testing` | `StaticIam`, `mockIamApi`, `staticResources`, Beispielkatalog `CATALOG` und `ME` |
| `@vollholz/iam-web/styles.css` | einmal importieren; alles in `@layer iam` |

## Schnellstart

```tsx
import { IamProvider, IamNav, AccountMenu, useIam } from '@vollholz/iam-web';
import '@vollholz/iam-web/styles.css';

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <IamProvider product="Notizen" router={router} features={{ entra: false }} resources={resources}>
      <App />
    </IamProvider>
  </QueryClientProvider>,
);
```

`IamProvider` lädt `/auth/me`, zeigt bei Bedarf die Anmeldung, die Auswahl der Organisation, «nicht verfügbar»,
«Sitzung abgelaufen» und `/abgemeldet`, und rendert die App erst mit Sitzung. Beim Wechsel der Organisation leert er den
Cache der App und baut sie neu auf. In der App: `useIam()` (`me`, `can`, `canSomewhere`, `orgName`, `switchOrg`,
`logout`), `<Can perm>`, `useAuthz()` für Labels aus dem Katalog.

Wichtige Props (vollständig in [docs/entwurf.md](docs/entwurf.md) 1.2):

| Prop | Wofür |
|---|---|
| `product`, `brand` | Name und Marke auf Auswahl- und Abmeldeseite |
| `router` | Router-Adapter (unten); Standard: History-API |
| `paths` | Pfade der Seiten; Standard wie Assets (`/verwalten/mitglieder` …). `paths.entra` muss zu den Redirect-URIs der Entra-App und `ENTRA_*` des Servers passen |
| `features` | `acl` (Standard: Katalog hat `acl:read`), `entra` (Standard aus), `platform` (Standard an) |
| `components` | eigene Grundkomponenten (`Button`, `Dialog`, `Menu`, `Table`, `Icon`, `toast`) |
| `roleGroups`, `roleIcons`, `inviteRoles` | Darstellung der Rollen, Vorgabe beim Einladen |
| `resources`, `people` | Adapter für Zugriffsregeln und Personenverzeichnis (unten) |
| `texts`, `locale` | eigene Texte je Sprache, z. B. `{ de: { 'iam.rights.rulesNote': '…' } }` |
| `onTenant`, `onLogout` | Rückmeldungen für persönliche Einstellungen der App |
| `rightsData` | Abfragen der App, die nach Änderungen an Rollen oder Zugriffsregeln neu laden (Fähigkeiten `can`); Standard: alle ausser denen des Pakets |
| `legacyTabKey` | früherer Schlüssel der Organisation je Tab (einmal übernommen) |

## Routen und Navigation

`iamRoutes` (bzw. `makeIamRoutes(paths, features, { param })`) liefert je Seite Pfad, Bedarf, Titel, Symbol und
`load()` mit Guard; die Seiten laden erst bei Bedarf. `<IamNav>` zeichnet die Gruppe «Zugang» nach Recht,
`useIamNav()` gibt die Einträge für eine eigene Leiste.

```tsx
// React Router
const routes = makeIamRoutes(paths, features).map(r => ({ path: r.path, lazy: async () => ({ Component: (await r.load()).default }) }));
// TanStack Router: Parameter als $alias, Suchtext unverarbeitet
const iam = makeIamRoutes(paths, features, { param: tanstackParam });
const router: IamRouter = {
  Link: ({ to, ...p }) => <Link to={to} {...p} />,
  navigate: (to, o) => (o?.replace ? tsr.history.replace(to) : tsr.history.push(to)),
  useSearch: () => useRouterState({ select: s => s.location.searchStr }),
  usePathname: () => useRouterState({ select: s => s.location.pathname }),
};
```

Die Rückkehrseiten von Microsoft (`<paths.entra>/zustimmung`, `/test`) haben keinen Guard; die API prüft selbst.

### Link an die Entra-Administration (ab 0.2.0)

Zustimmen darf bei Microsoft nur eine globale Administration oder eine Administration für privilegierte Rollen des
Verzeichnisses – oft die Kunden-IT, nicht die Organisations-Administration der App. Unter «Anmeldung» erzeugt die
Organisations-Administration deshalb einen Link mit Gültigkeit (15 Minuten bis 24 Stunden) und gibt ihn weiter; die
Liste zeigt Status, Ablauf, Zustimmung und Fehler und erlaubt das Widerrufen aller noch einlösbaren Links (offen, in
Arbeit, gescheitert; sie zählen zum Limit von 5 offenen Links).

Der Link führt auf `<paths.entra>/freigabe#<token>`. `IamProvider` zeigt diese Seite und ihre Rückkehr von Microsoft
(`<paths.entra>/zustimmung` mit `state` `h.…`) **ohne Sitzung** und ohne /auth/me (nur mit `features.entra`); die App
braucht dafür keine eigene Route. Das Token kommt nur aus dem Fragment, verschwindet danach aus der Adresse und geht nur
im Body an `/v1/entra/handover/*` (ohne Cookie, X-Tenant und CSRF). `paths.entra` muss zu `ENTRA_UI_PATH` des Servers
passen.

- **Fragment sofort weg:** `IamProvider` nimmt das Token schon beim ersten Rendern aus der Adresse (vor dem Nachladen
  der Seite). Auf …/freigabe geschieht das auch, wenn die Seite nicht erkannt wird (z. B. `features.entra` fehlt); ein
  Fragment, das ein Token sein könnte, kommt nie in `returnTo` der Anmeldung.
- **Seite der App absichern:** Für die Freigabeseite `Content-Security-Policy: frame-ancestors 'none'` und keine
  Skripte Dritter (Analyse, Session-Replay, Chat), da sie die Seite mit dem Token im Speicher sehen.
- **Restrisiko:** Der Link selbst liegt bis zum Einlösen in Mail, Chat und ggf. im Verlauf des Browsers. Mail-Gateways
  mit Link-Prüfung sehen den ganzen Link und können die Seite öffnen; das zeigt nur die Angaben, eingelöst wird erst
  nach der Zustimmung bei Microsoft. Darum kurz gültig (Standard 15 Minuten), einmal
  einlösbar, an Organisation und Verzeichnis gebunden und widerrufbar.
- **Neuladen der Rückkehr:** Nach dem Abschluss entfernt die Rückkehrseite `code` und `state` aus der Adresse. Lädt die
  Person die Seite danach neu, fehlt der `state`, und `<paths.entra>/zustimmung` braucht wie jede andere Seite die
  Sitzung (Weiterleitung zur Anmeldung). Die Meldung «Verbunden – Sie können dieses Fenster schliessen» steht vorher.

### Eigene App-Registrierung (ab 0.3.0)

Meldet der Server `methods.ownApp` (iam 0.3.0), verbindet die Organisation Microsoft Entra ID über eine eigene
App-Registrierung in ihrem Verzeichnis statt über die App der Plattform. Ohne `methods.platformApp` gibt es kein «Mit
Entra ID verbinden» mehr; angeboten wird, was der Server meldet (ältere Server ohne `methods`: nur die Zustimmung).

- **Eigene App verbinden:** Der Dialog führt Schritt für Schritt durch die App-Registrierung (nur dieses Verzeichnis,
  Plattform «Web» mit der Umleitungs-URI des Servers, Berechtigungen von Microsoft Graph mit Administratorzustimmung,
  Secret) und nimmt Verzeichnis (ID oder Domäne), Anwendungs-ID und Secret entgegen (`PUT …/entra/app`). Kontotyp
  zwingend «Nur Konten in diesem Organisationsverzeichnis»; Application.Read.All ist Pflicht (Nachweis der Registrierung
  im Verzeichnis, Ablauf des Secrets). Ein Feld für den Ablauf erscheint nur, wenn die Anleitung des Servers diese
  Berechtigung nicht als Pflicht meldet. Fehler wie falsches oder abgelaufenes Secret, falsches Verzeichnis, App nicht im
  Verzeichnis registriert oder fehlende Berechtigungen bzw. Zustimmung erscheinen mit eigenem Text. Passwort-Manager
  sollen das Secret nicht speichern (`autocomplete="new-password"`, Ignorier-Attribute der gängigen Manager).
- **Secret wechseln:** Bei der eigenen App zeigt «Anmeldung» den Ablauf des Secrets mit Warnung (bald fällig,
  abgelaufen); «Secret wechseln …» nimmt das neue Secret (das Verzeichnis bleibt, die Anwendungs-ID darf wechseln).
- **Link «Credentials eintragen»:** «Link an die Entra-Administration senden» erzeugt im Modus der eigenen App einen
  Link, über den die Kunden-IT die App-Registrierung anlegt und die Angaben selbst einträgt – ohne Konto in der App,
  mit derselben Anleitung («Sie»); das Verzeichnis gibt der Link vor. Für das Token gilt dasselbe wie in 0.2.0 (Fragment sofort weg, nur im Body, nie in
  `returnTo`); das Secret geht nur im Body an `/v1/entra/handover/credentials` und erscheint nie wieder.

`OwnAppDialog`, `OwnAppGuideSteps`, `OwnAppFields` und `ownAppErrorText` stehen unter `./pages` auch einzeln bereit.

## Adapter

**`resources`** (nur mit Zugriffsregeln): Namen, Auswahl und Kette der Ressourcen der App.

```ts
const resources: IamResources = {
  useResolver: () => { const f = useFolders(); return { name: (t, id) => f.byId(id)?.name, known: (t, id) => (f.data ? !!f.byId(id) : undefined) }; },
  pick: (type, q, signal) => api.searchFolders(q, signal).then(r => r.map(x => ({ value: x.id, label: x.name }))),
  useChain: (type, id) => useParents(type, id),   // Stufen über der Ressource, ohne tenant; undefined = lädt
  noGrant: ['note'],                               // Blatt der Kette, solange der Katalog `leaf` nicht meldet
};
```

**`people`**: Standard ist `GET /v1/people` (Suche `q`, Auflösung `ids` bis 100). `<PersonName id>` zeigt den Namen
zu einer Principal-ID und sammelt die Abfragen einer Darstellung zu einem Aufruf.

**`AclHint`** an einer Ressource der App: «Zugriff eingeschränkt (1 hier, 2 von «Projekte»)» mit Link auf die
gefilterte Seite «Zugriff»; ohne `acl:read` nichts.

## Aussehen und Texte

`styles.css` legt Vorgaben für `--iam-*` hell und dunkel in `@layer iam` fest; jede Regel der App ausserhalb einer
Ebene gewinnt. Die App bildet ihre Tokens ab, z. B. `:root { --iam-accent: var(--accent); --iam-surface: var(--surface); }`.
Klassen des Pakets beginnen mit `iam-`. Texte: `texts` am Provider, `t()`/`tn()` für eigene Stellen.

## Tests der App

```tsx
import { StaticIam, mockIamApi, json, staticResources } from '@vollholz/iam-web/testing';

vi.stubGlobal('fetch', mockIamApi({ 'GET /v1/notes': () => json({ items: [] }) }).fetch);
render(<StaticIam me={{ roles: ['viewer'] }} config={{ resources: staticResources({ folder: { f1: 'Projekte' } }) }}><NotesPage /></StaticIam>);
```

`StaticIam` stellt eine feste Sitzung ohne Server bereit; `mockIamApi` beantwortet `/auth/me`, Katalog und Rollen
selbst und zeichnet alle Aufrufe auf (`calls`).

## Umstellung von Assets

Der Weg steht in [docs/entwurf.md](docs/entwurf.md) Kap. 8 (eigener PR in vollholz/assets, Paket gepinnt, Abnahme
per Screenshot-Vergleich). Seit dem Entwurf dazugekommen:

- `resources.noGrant: ['object']` setzen, solange `GET /v1/authz/catalog` `resourceTypes[].leaf` nicht ausliefert.
  Ohne beides ist «Freigeben» nur auf der ganzen Organisation möglich, und die Konsole warnt.
- `groupRolePrefix` entfällt, wenn der Server ihn in `/v1/admin/status` meldet (ab Backend Teil 6b); sonst als Prop.
- `entraConsentHosts` nur für nationale Clouds; Standard `login.microsoftonline.com`.
- TanStack Router: `makeIamRoutes(…, { param: tanstackParam })`.
- Bekannte Unterschiede, die Assets mitnimmt: Auswahl im Dialog über dem Overlay (in Assets liegt sie darunter),
  Person- und Organisationswechsel leeren Abfragen und Mutationen der App, «Einladung erneut senden» nur mit E-Mail,
  Anmeldelinks und Zustimmung nur an erlaubte Adressen.

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

Den Auszug `test/fixtures/openapi-iam.json` bei Vertragsänderungen aus der OpenAPI von `@vollholz/iam` erneuern (Pfade
`/auth/*`, `/v1/authz/catalog`, `/v1/acl*`, `/v1/roles*`, `/v1/admin/*`, `/v1/platform/*`, `/v1/people*` mit den
benutzten Schemas, ohne Beschreibungstexte).

Veröffentlicht wird nach dem Merge auf main durch den Workflow Release (GitHub Packages, Tag `iam-web-v<version>`);
eine neue Version heisst: `version` in `package.json` erhöhen.
