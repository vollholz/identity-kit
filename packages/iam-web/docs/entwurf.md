# Entwurf: `@vollholz/iam-web`

Stand 2026-10-22 · Status: **freigegeben** (identity-kit#4, mit Auflagen; nachgeführt im ersten Umsetzungs-PR) · Spezifikation: [Kap. 11](../../../docs/spezifikation.md#11-oberfläche),
[15.2](../../../docs/spezifikation.md#152-schnittstelle-zur-app) · Referenz: vollholz/assets `3a148ae`, `web/`

Das Paket bringt Anmeldung, Organisation je Tab, Rechte-Bausteine und die Verwalten-Seiten des Baukastens in jede
React-App. Die App liefert nur Design-Tokens, Texte (Überschreibungen, weitere Sprachen), ihren Katalog (über die API)
und – falls sie Zugriffsregeln nutzt – die Auflösung ihrer Ressourcen. Alles andere kommt aus dem Paket, ohne Kopien.

Grundlage ist der Code von Assets (`web/src/auth/*`, `shell/{UserMenu,MyRights}.tsx`, `ui/{MissingRight,
RightsOverview,RoleMatrix,AdminHead,MenuButton,Overlay,Picker,states,org}`, `features/{admin,acl}/*`, `api/{client,
problem,admin,roles}.ts`, rund 4500 Zeilen ohne Tests). Er wird übernommen, nicht neu geschrieben: Verhalten, Texte und
Tests bleiben gleich, nur was Assets-spezifisch ist, wird zur Eingabe der App (Abschnitt [Was produktneutral
wird](#was-produktneutral-wird)).

## Inhalt

1. [Öffentliche API](#1-öffentliche-api)
2. [Theming und Grundkomponenten](#2-theming-und-grundkomponenten)
3. [Texte](#3-texte)
4. [Abhängigkeiten](#4-abhängigkeiten)
5. [Barrierefreiheit](#5-barrierefreiheit)
6. [Teststrategie](#6-teststrategie)
7. [Plan der Teil-PRs](#7-plan-der-teil-prs)
8. [Umstellung von Assets (Phase 2)](#8-umstellung-von-assets-phase-2)
9. [Fragen zum Vertrag](#9-fragen-zum-vertrag)

## 1. Öffentliche API

### 1.1 Einstiegspunkte

| Import | Inhalt | Warum getrennt |
|---|---|---|
| `@vollholz/iam-web` | `IamProvider`, Hooks, Rechte-Bausteine, Routen-Guard, Kontomenü, Grundkomponenten, `iamRoutes` und `IamNav` | Kern, den jede Seite der App braucht; die Routen liegen hier, damit Router und Navigation der App die Seiten nicht mitladen |
| `@vollholz/iam-web/pages` | Verwalten-Seiten (Mitglieder, Rollen, Maschinen-Clients, Anmeldung, Zugriff, Organisationen), ohne Guard (`MembersPage` …) und mit Guard (`MembersScreen` …) | Die App lädt sie per `lazy()` bzw. `iamRoutes[].load()` nach; der Kern bleibt klein |
| `@vollholz/iam-web/testing` | `StaticIam` (feste Sitzung ohne Server), `mockIamApi` (fetch-Ersatz für `/auth/*` und `/v1/…` des Vertrags), Beispiel-`Me` und Beispielkatalog | Tests der App ohne eigene Nachbildung (heute `web/src/test/utils.tsx` in Assets) |
| `@vollholz/iam-web/styles.css` | Struktur und Aussehen aus `--iam-*` | Einmal in der App importieren |

**Build mit `tsc`** (wie `iam-testkit`), ESM mit `.d.ts`, kein Bundler im Paket:

- Quellen importieren mit Endung `.ts`/`.tsx`; `rewriteRelativeImportExtensions` macht daraus `.js` in `dist`, damit
  Node, Vite und andere Bundler `dist` ohne eigene Auflösung laden.
- Kein Quellmodul importiert CSS. Das Stylesheet ist eine einzige Datei `src/styles.css`, die der Build nach
  `dist/styles.css` kopiert (`scripts/build.ts`); `exports["./styles.css"]` zeigt darauf. Die App importiert es einmal.
  So funktioniert `dist` auch in Umgebungen ohne CSS-Loader (Vitest der App, SSR), und die App bestimmt die Reihenfolge.
- Ein Bundler (Vite-Library, tsup) brächte nur Minifizierung, die die App ohnehin selbst macht, und eine zweite
  Build-Konfiguration; deshalb nicht.
- Ein Test packt das Paket (`npm pack`), lädt `dist/index.js` in Node und prüft die Exporte.

### 1.2 Provider

```tsx
import { IamProvider } from '@vollholz/iam-web';
import '@vollholz/iam-web/styles.css';

<IamProvider
  product="Notizen"                         // Anzeigename (Seitentitel, Auswahlseite, «Du bist abgemeldet»)
  locale="de"                               // 'de' | 'en' | weitere aus texts
  texts={{ de: { 'iam.rules.note': '…' } }} // überschreibt einzelne Schlüssel, ergänzt Sprachen
  queryClient={queryClient}                 // optional; sonst der aus QueryClientProvider, sonst ein eigener
  router={routerAdapter}                    // Navigation und Suchparameter (1.6); ohne: History-API
  features={{ acl: true, entra: true, platform: true }} // optional (1.5)
  legacyTabKey="assets.tab.org"             // optional: früherer Schlüssel der Organisation je Tab (einmal übernommen)
  onTenant={me => …} onLogout={() => …}     // optional: eigene Einstellungen je Person und Organisation
  paths={{ members: '/verwalten/mitglieder', … }} // optional, Standard wie Assets (1.6)
  components={{ Button, Dialog, Menu, Table, Icon, toast }} // optional (2.2)
  roleGroups={[…]}                          // optional: Gruppen im Rollendialog (Darstellung)
  roleIcons={{ editor: 'edit' }}            // optional: Symbol je vordefinierter Rolle
  resources={noteResources}                 // nur mit Zugriffsregeln (1.7)
  people={peopleAdapter}                    // optional, Standard /v1/people (1.8)
  brand={<Logo />}                          // optional: Marke auf Auswahl- und Abmeldeseite
>
  <App />
</IamProvider>
```

Verhalten wie `SessionProvider` in Assets (Spezifikation 11.1):

- Start mit `GET /auth/me` (mit `X-Tenant` der Organisation des Tabs); 401 → `loginUrl()` =
  `/auth/login?returnTo=<adresse>[&org=<alias>]` (exportiert, auch für Links der App).
- Mehrere Organisationen ohne Wahl → Auswahlseite; Organisation des Tabs nicht mehr verfügbar → Hinweis mit Wechsel
  und «Neu laden», nie Daten einer anderen Organisation.
- `/abgemeldet` (Pfad aus `paths.loggedOut`) → öffentliche Seite «Du bist abgemeldet», ohne `/auth/me`.
- Jede 401 öffnet «Sitzung abgelaufen» mit «Erneut anmelden» (Eingaben bleiben); jede 403 lässt `/auth/me` prüfen.
- Anderer Mandant im Tab → Cache der App ausser `/auth/me` leeren (deshalb der gemeinsame `QueryClient`, Abschnitt 4).
- Abmelden: `POST /auth/logout`, Organisation des Tabs löschen, Hook `onLogout` der App (z. B. persönliche
  Einstellungen löschen, in Assets `clearPersonalPrefs`).
- **Organisation je Tab** in `sessionStorage` unter `iam.tab.org`: `{ sub, alias, name }`. Gehört der gespeicherte
  `sub` nicht zur angemeldeten Person (andere Person im selben Tab), gilt die Wahl nicht: verwerfen, `/auth/me` ohne
  `X-Tenant` neu laden. Ohne Speicher (gesperrt, privates Fenster) gilt die Wahl bis zum Neuladen. `legacyTabKey`
  übernimmt einmal einen früheren Schlüssel (Assets: `assets.tab.org`) und löscht ihn.

### 1.3 Hooks

| Hook | Liefert | Herkunft Assets |
|---|---|---|
| `useIam()` | `me`, `can(p)`, `canSomewhere(p)`, `switchOrg(alias)`, `logout()`, `orgName` (Name der Organisation des Tabs) | `useSession`, `ui/org.ts` |
| `useAuthz()` | Katalog mit eigenen Rollen: `permission`, `permLabel`, `roleLabel`, `rolesWith`, `scopeText`, `resourceLabel`, `groupRoles` | `auth/authz.ts` |
| `useResourceCan()` | `(resource, capability, perm) => boolean` nach `can` der Ressource, sonst Mandantenebene | `auth/resource-can.ts` |
| `useIamFetch()` | `fetch` mit Cookie, `X-Tenant`, `X-CSRF-Token`, problem+json → `ApiError`, 401/403-Meldung; für eigene Aufrufe der App | `api/client.ts` |
| `iamKeys` | Abfrageschlüssel des Pakets (unten; Konstante, der Katalog mit `iamKeys.catalog(locale)`) | `aqk`, `authzKey`, `rolesKey` |
| `useIamText()` | `{ t, tn, locale }` (Abschnitt 3); zeichnet bei Wechsel der Sprache neu | neu |
| `useAdminStatus()`, `useRoles()`, `useMembers(alias)`, `useClientGrants(alias)` | Daten der Verwaltung, für eigene Anzeigen der App | `api/admin.ts`, `api/roles.ts` |

Ausserdem ohne React:

- `ApiError`, `networkError`, `describeError`, `fieldErrorText` – **einzige** Fehlerklasse; die App übernimmt sie aus
  dem Paket (Assets löscht `api/problem.ts`), damit `instanceof ApiError` überall gilt.
- `withTenant(url)` (Links mit `?x-tenant=`), `tenantHeaders()` (`X-Tenant`/`X-CSRF-Token` für eigene Aufrufe),
  `ifMatch(version)`, `loginUrl(returnTo?, org?)`, `ADMIN_ROLE`, `PLATFORM_ADMIN`, `isCustomRole`, Formatierung
  `fmtDate`, `fmtDateTime`, `relTime`, `fmtNum`, `plural` (aus Assets `ui/format.ts`, auf `Intl` mit `locale`).
- **Rückkanal für eigene Clients der App** (401 → «Sitzung abgelaufen», 403 → `/auth/me` neu prüfen):
  - `reportStatus(status)` meldet den Status einer Antwort, die nicht über das Paket lief;
  - `iamMiddleware` erfüllt die Middleware-Schnittstelle von `openapi-fetch` (`onRequest` setzt `X-Tenant`,
    `X-CSRF-Token`, `Accept`; `onResponse` wirft `ApiError` und meldet 401/403; `onError` → `networkError`), ohne
    `openapi-fetch` zu importieren (nur strukturell typisiert). Assets: `api.use(iamMiddleware)`.
  - `onSessionExpired(fn)`, `onForbidden(fn)` für Tests und Sonderfälle.

**Abfrageschlüssel** (für Invalidierung durch die App; alle beginnen mit `'iam'`, damit der Wechsel der Organisation
sie gezielt behalten oder leeren kann):

| Schlüssel | Daten |
|---|---|
| `['iam', 'me']` | `/auth/me` (bleibt beim Wechsel, wird neu geladen) |
| `['iam', 'catalog', locale]` | `/v1/authz/catalog` in der Sprache `locale` |
| `['iam', 'roles']` | `/v1/roles` |
| `['iam', 'admin', 'status']`, `['iam', 'admin', 'members', alias]`, `['iam', 'admin', 'clients', alias]`, `['iam', 'admin', 'entra', alias]`, `['iam', 'admin', 'orgs'[, alias]]` | Verwaltung; `alias` = `'_own'` für die eigene Organisation |
| `['iam', 'acl']`, `['iam', 'acl', 'effective', query]` | Zugriffsregeln, «Rechte prüfen» |
| `['iam', 'people', 'one', id]`, `['iam', 'people', 'search', q]` | Personenverzeichnis |

**Typen der Rechte.** Das Paket kennt die Rechte der App nicht. Die App registriert ihren Typ einmal (Muster wie
TanStack Router), danach prüfen `can`, `Requires`, `MissingRight` die Schlüssel:

```ts
declare module '@vollholz/iam-web' {
  interface Register { permission: Permission }   // Permission aus dem Katalog der App
}
```

Ohne Registrierung ist `Permission` = `string`. Die reservierten Rechte (`tenant:read`, `members:admin`, `acl:read`,
`acl:admin`, …) nutzt das Paket als Konstanten (Spezifikation 8.1).

### 1.4 Rechte-Bausteine

| Baustein | Zweck (Spezifikation) |
|---|---|
| `<Can perm>` | nur mit Recht anzeigen, sonst `fallback` |
| `<MissingRight perm lead? page?>`, `missingRightText()` | fehlendes Recht an der Stelle der Aktion: Label, Rollen, wer vergibt (11.2) |
| `<NoPermission perm title icon>` | ganze Seite «Recht fehlt» |
| `<Requires perm somewhere? title? icon?>` | Routen-Guard: Kinder nur mit Recht, sonst `NoPermission` (11.2); `somewhere` (Standard) prüft `canSomewhere` wie `requires()` in Assets |
| `<RequiresPlatformAdmin title? icon?>` | Guard für die Plattform-Administration: `platformAdmin` aus `GET /v1/admin/status` (Realm-Rolle, **kein** Recht des Katalogs); sonst `NoPermission` mit `PLATFORM_ADMIN` |
| `<RightsOverview roles permissions scopes admin rulesNote>`, `rightsModel()` | Rechte-Übersicht für alle Blickwinkel (11.2) |
| `<RoleMatrix>`, `<RoleCompare>` | Rechtegruppe × Rolle, ohne waagrechtes Scrollen |
| `<MyRightsDialog>` | «Meine Rollen und Rechte» |
| `<AccountMenu avatar extraItems?>` | Kontomenü: Person, Organisation, «Meine Rollen und Rechte», Organisation wechseln, Abmelden; die App ergänzt eigene Einträge (`extraItems(close)`) |
| `<OrgName>`, `useOrgSwitchItems()` | Name der Organisation für die Kopfzeile; Einträge «Zu «X» wechseln» (`{ alias, name, label, run }`) für die Befehlspalette der App |
| `<AdminHead icon title sub? actions? crumbs?>` | Kopf der Verwalten-Seiten: Pfad «Produkt › Verwalten › … › Titel» mit Links über den Router-Adapter |
| `<AclHint resourceType resourceId>` | «Zugriff eingeschränkt (n)» an einer Ressource (nur mit Zugriffsregeln) |
| `<NotFound>`, `<ErrorState>`, `<ErrorBox>`, `<Loading>`, `<Empty>` | Zustände wie in Assets, 404-Text nach 11.1 |

### 1.5 Seiten

Aus `@vollholz/iam-web/pages`; jede Seite prüft ihr Recht selbst nicht, das machen `Requires` bzw.
`RequiresPlatformAdmin` (wie heute in Assets).

| Seite | Pfad (Standard) | Recht | Herkunft Assets |
|---|---|---|---|
| `MembersPage` | `/verwalten/mitglieder` | `members:admin` | `features/admin/Members.tsx` |
| `RolesPage` | `/verwalten/rollen` | `members:admin` (Seite und Navigation, wie Assets; `GET /v1/roles` bleibt mit `tenant:read` lesbar) | `Roles.tsx` |
| `ClientsPage` | `/verwalten/maschinen-clients` | `members:admin` | `Clients.tsx` |
| `EntraPage`, `EntraConsentReturn`, `EntraTestReturn` | `/verwalten/anmeldung`, `…/zustimmung`, `…/test` (nur mit `features.entra`) | `members:admin` bzw. API prüft | `EntraLogin.tsx` |
| `AccessPage` | `/verwalten/zugriff` | `acl:read` | `features/acl/*` |
| `OrganizationsPage`, `OrganizationPage` | `/verwalten/organisationen[/:alias]` | Plattform-Administration (`RequiresPlatformAdmin`) | `Organizations.tsx` |

Dazu im Kern `iamRoutes`: Liste aller Seiten, aus der die App ihre Routen und ihre Navigation erzeugt (Standardpfade;
mit eigenen Pfaden `makeIamRoutes(paths)`), `useIamNav()` mit den erlaubten Einträgen und `active` für eine eigene
Leiste der App (Assets: `Rail.tsx`) und `<IamNav>` als fertige Gruppe «Zugang» (Mitglieder, Rollen, Anmeldung,
Maschinen-Clients, Zugriff, Organisationen – je nach Recht und `features`). `load()` importiert den Einstieg `./pages`
dynamisch; ein Bundler der App macht daraus einen eigenen Teil. Umgesetzt sind Mitglieder und Rollen (PR 4),
Maschinen-Clients und Organisationen (PR 5a); Anmeldung (5b) und Zugriff (6) kommen dazu. Der Parameter der
Detailseite steht in der Schreibweise von React Router (`/verwalten/organisationen/:alias`, TanStack Router: `$alias`);
die Seite liest den Alias selbst aus dem Pfad oder nimmt ihn als Prop.

```ts
interface IamRoute {
  id: 'members' | 'roles' | 'clients' | 'entra' | 'entraConsent' | 'entraTest' | 'access' | 'organizations' | 'organization';
  path: string;                                  // aus `paths`
  need: { perm: Permission } | { platformAdmin: true } | null;   // null: die API prüft (Rückkehrseiten von Entra)
  readonly title: string;                        // in der Sprache der Texte (beim Lesen)
  icon: IamIconName; nav: boolean;               // nav: erscheint in IamNav
  load: () => Promise<{ default: ComponentType }>;// Seite mit Guard
}
```

`features` (App-Schalter, Standard in Klammern): `acl` (Katalog enthält `acl:read`), `entra` (aus; Assets setzt
`true`), `platform` (an). Ob Entra in der Organisation verbunden ist, sagt `enabled` aus `GET /v1/admin/entra`; ohne
`features.entra` ruft das Paket diesen Endpunkt nie auf.

Beispiel TanStack Router (Assets):

```tsx
for (const r of makeIamRoutes(paths, features, { param: tanstackParam })) createRoute({ getParentRoute: () => adminRoute,
  path: r.path.replace('/verwalten', ''), component: lazyRouteComponent(r.load, 'default') });
```

Beispiel React Router: `<Route path={r.path} lazy={async () => ({ Component: (await r.load()).default })} />`.

### 1.6 Router und Pfade

Das Paket hängt von **keinem** Router ab. Es braucht vier Dinge, die die App über `router` liefert:

```ts
interface IamRouter {
  Link: ComponentType<{ to: string; className?: string; children: ReactNode; 'aria-current'?: 'page'; title?: string }>;
  /** `to` ist Pfad mit Suchtext, z. B. `/verwalten/zugriff?ansicht=pruefen&client=x`. */
  navigate(to: string, opts?: { replace?: boolean }): void;
  /** Unverarbeiteter Suchtext der aktuellen Adresse (`location.search`, mit «?» oder leer). */
  useSearch(): string;
  usePathname(): string;
}
```

Das Paket liest und schreibt Suchparameter nur als Text (`URLSearchParams`) und navigiert mit vollständigen Adressen.
Der Adapter gibt den **unverarbeiteten** Suchtext zurück, nicht die vom Router umgewandelten Werte (TanStack Router
macht aus `?client=123` eine Zahl und schreibt JSON-Werte in Anführungszeichen). Für TanStack Router:
`useSearch: () => useRouterState({ select: s => s.location.searchStr })`, `navigate: to => router.history.push(to)`
(nicht `router.navigate({ search })`, das die Werte erneut umwandeln würde).

Ohne Adapter nutzt das Paket die History-API (`pushState` und `popstate`); das genügt für Apps ohne Router und für
die Tests. Ziele innerhalb des Pakets (Organisation → Detail, Maschinen-Client → «Rechte prüfen», `AclHint` →
gefilterte Zugriffsseite) laufen über `paths`, Standardwerte wie in Assets. Suchparameter der Zugriffsseite
(`ansicht`, `resourceType`, `resourceId`, `permission`, `who`, `client`, `rolle`) bleiben gleich, damit Links aus
Assets weiter gelten. Die Rückkehr-Pfade von Entra (`…/anmeldung/zustimmung`) sind bei Microsoft registriert; sie
kommen von der API (`redirect`), die App muss nur die Route haben.

### 1.7 Ressourcen der Zugriffsregeln

Ressourcentypen und ihre Labels kommen aus dem Katalog. Namen, Auswahl und Kette der einzelnen Ressourcen kennt nur die
App (15.2). Ohne Zugriffsregeln entfällt der Adapter.

```ts
interface IamResources {
  /** Name und Bekanntheit je Ressource; als Hook, damit die App ihre Abfragen (Cache) nutzt. */
  useResolver(): { name(type: string, id: string): string | undefined; known(type: string, id: string): boolean | undefined };
  /** Auswahl im Dialog «Zugriffsregel hinzufügen» (Suche, höchstens 50). */
  pick(type: string, query: string, signal: AbortSignal): Promise<{ value: string; label: string; sub?: string }[]>;
  /**
   * Kette über der Ressource (ohne sie selbst und ohne tenant), für Vorschau und AclHint. Als Hook, weil die Kette
   * oft erst geladen werden muss: `undefined` = lädt noch, `[]` = keine Stufe darüber.
   */
  useChain?(type: string, id: string | null): { type: string; id: string; label: string }[] | undefined;
  /** Auf welchen Typen keine Freigabe möglich ist (Blatt der Kette, Spezifikation 7.1); Standard: Typen mit `leaf` im Katalog. */
  noGrant?: string[];
}
```

Umgesetzt in PR 6. Das Blatt kennt der Server (`ResourceDef.leaf` in `@vollholz/iam`); der Katalog
(`GET /v1/authz/catalog`) liefert `leaf` noch nicht aus, deshalb liest die Oberfläche `resourceTypes[].leaf`, wenn es da
ist, sonst gilt `noGrant` der App (Vertragsfrage). Der Zusatz «(auch auf allem darunter)» in der Vorschau steht auf der
Organisation und auf allen Typen ausser dem Blatt. Ohne Adapter zeigt die Seite IDs und nimmt die ID als Eingabe; ohne
`useChain` rechnet die Vorschau nur mit Organisation und Ressource und sagt das. Für Tests und Testseiten erzeugt
`staticResources(names, { parents, noGrant })` aus `./testing` einen Adapter aus festen Daten.

### 1.8 Personenverzeichnis

`GET /v1/people` gehört zum Vertrag (V1): Suche `?q=&limit=` und Auflösung `?ids=` (höchstens 100 je Aufruf; nicht
gefundene IDs fehlen in der Antwort wie ein 404). Die Standard-Umsetzung des Adapters ruft genau das auf; eine App mit
eigenem Verzeichnis ersetzt sie:

```ts
interface IamPeople {
  search(q: string, signal: AbortSignal): Promise<IamPerson[]>;     // höchstens 20 Treffer
  resolve(ids: string[], signal: AbortSignal): Promise<IamPerson[]>; // fehlende IDs fehlen in der Antwort
}
interface IamPerson { id: string; name: string; email: string | null }   // id = Principal-ID
```

Der Baustein `<PersonName id>` löst gesammelt auf (ein Aufruf je Darstellung, Zwischenspeicher unter
`['iam', 'people', 'one', id]`) und zeigt bis dahin die gekürzte ID.

### 1.9 Was produktneutral wird

| In Assets fest | Im Paket |
|---|---|
| `Permission` als Union aller 32 Rechte | `Register` der App (1.3) |
| `ROLE_GROUPS` (Verwaltung/Arbeit/Kontrolle mit Assets-Rollen), `ROLE_ICON` | Props `roleGroups`, `roleIcons`; Standard: «Gesamte Organisation» (`org-admin`), «Rollen» (übrige vordefinierte), «Eigene Rollen» |
| `RULES_NOTE` nennt Schemas, Typen, Verbindungen | Text `iam.rights.rulesNote` (neutral: «… für einzelne Bereiche …»); die App überschreibt ihn über `texts` |
| Ressourcennamen aus `useCatalog`, `useConnections`, `useCredentials`; Regel «keine Freigabe auf `object`» | `resources` (1.7) |
| `UserChip` und Personensuche aus `/v1/people` | `people`-Adapter mit Standard `/v1/people` (1.8) |
| Marke «Assets» mit Symbol `layers` auf Auswahl- und Abmeldeseite | `product`, `brand` |
| Icons der App (`ui/icons.ts`, 70 Symbole) | eigener kleiner Satz oder `components.Icon` mit diesen Namen (`IamIconName`, die Teilmenge der Namen von Assets, die die übernommenen Teile nutzen): `building`, `check`, `chevron`, `clock`, `copy`, `edit`, `eye`, `info`, `key`, `link`, `mail`, `minus`, `more`, `plus`, `refresh`, `search`, `shield`, `tag`, `trash`, `user`, `users`, `warn`, `x`; die endgültige Liste legt PR 3 fest (Test: jeder genutzte Name steht in der Liste) |
| Toasts der App (`ui/Toasts.tsx`) | `components.toast`, sonst eigene Meldungen (`aria-live`) |
| Personen-Einstellungen (`ui/prefs.ts`) | nicht im Paket; Hooks `onTenant(me)`, `onLogout()` |

## 2. Theming und Grundkomponenten

### 2.1 CSS-Variablen

Die Bausteine bringen kein Erscheinungsbild der App mit. `styles.css` enthält Struktur (Raster, Stapeln unter 760 px,
Menüs, Dialoge, Tabellen) und färbt nur über `--iam-*`; alle Klassen tragen den Präfix `iam-`, damit nichts mit der App
kollidiert. Die Werte sind neutral vorbelegt (hell und dunkel nach `prefers-color-scheme`), die App setzt sie aus
ihren Tokens.

**Die Variablen der App gewinnen immer:** Die Vorgaben der Variablen stehen in `@layer iam` und unter `:where(:root)`
(Spezifität 0), auch die dunklen in `@media (prefers-color-scheme: dark)`; ebenso die Grundregeln (`box-sizing`, Schrift
und Farbe der Bedienelemente, Fokus). Jede Regel der App ausserhalb einer Ebene geht damit vor, gleich welche
Reihenfolge, Spezifität oder Systemfarbe gilt. Die **Regeln der Bausteine** (Klassen `iam-*`) stehen dagegen ohne Ebene:
Sonst überdeckten Element-Regeln der App wie `a { color: inherit }` oder `h1 { margin: 0 }` die Klassen der Bausteine
(gefunden bei der Probe in Assets: weisse Schrift auf dem Knopf «Erneut anmelden» wurde dunkel). Die App überschreibt
Klassen der Bausteine mit gleicher Spezifität nach dem Stylesheet des Pakets. Tests im Browser prüfen beides. Beispiel
Assets:

```css
:root { --iam-accent: var(--accent); --iam-surface: var(--surface); --iam-text: var(--fg); … }
```

| Variable | Zweck |
|---|---|
| `--iam-font`, `--iam-font-display`, `--iam-font-mono` | Schrift (Text, Überschriften, Schlüssel) |
| `--iam-bg`, `--iam-surface`, `--iam-surface-2`, `--iam-hover` | Flächen |
| `--iam-text`, `--iam-text-2`, `--iam-text-3` | Text (stark, normal, leise; `--iam-text-3` muss 4.5:1 auf `--iam-surface` erreichen) |
| `--iam-line`, `--iam-line-2` | Linien |
| `--iam-accent`, `--iam-accent-hover`, `--iam-accent-text`, `--iam-accent-soft` | Akzent, beim Überfahren, Text darauf, Hintergrund gewählter Zeilen |
| `--iam-ok`, `--iam-warn`, `--iam-bad`, `--iam-info`, `--iam-off` und je `…-soft` | Status (erlaubt, fehlt, verboten, Hinweis, aus) |
| `--iam-bad-text` | Text auf `--iam-bad` (Knopf «Löschen», Fehlermeldung); dunkel nicht weiss, sonst zu wenig Kontrast |
| `--iam-focus` | Fokusring (Standard: `--iam-accent`) |
| `--iam-shadow` | Schatten von Dialog, Menü, Meldung |

Abstände und Rundungen sind fest wie in Assets (keine Variablen), damit eine App mit gleichen Tokens gleich aussieht.
Abbildung für Assets: `--iam-text` ← `--fg`, `--iam-text-2` ← `--fg-2`, `--iam-text-3` ← `--fg-3`, `--iam-accent-text` ←
`--accent-fg`, `--iam-font` ← `--f-body`, `--iam-font-display` ← `--f-display`, `--iam-font-mono` ← `--f-mono`, übrige
gleichnamig (`--iam-bad` ← `--bad` …); `--iam-bad-text` setzt Assets hell `#fff`, dunkel dunkel (heute weiss, zu wenig
Kontrast – sichtbare Verbesserung, im Screenshot-Vergleich begründet).

Hell/dunkel steuert die App: sie setzt die Variablen in ihrem dunklen Thema (Assets: `[data-theme=dark]`). In
`forced-colors` nutzen die Bausteine Systemfarben.

### 2.2 Austauschbare Grundkomponenten

Über `components` ersetzt die App einzelne Grundkomponenten durch ihre eigenen; ohne Angabe gelten die des Pakets
(übernommen aus Assets `ui/`). Verhalten (Fokus, Tastatur, ARIA) ist Teil des Vertrags jeder Komponente; eigene
Komponenten müssen es erfüllen, die Tests des Pakets prüfen das mit den Standard-Komponenten.

| Schlüssel | Vertrag (Props) | Standard aus |
|---|---|---|
| `Button` | `variant?: 'default' \| 'primary' \| 'ghost' \| 'danger' \| 'danger-solid'`, `size?: 'sm'`, `icon?: IamIconName`, `busy?` (→ `aria-disabled`, bleibt fokussierbar, Klick wirkt nicht), mit `href` ein Link, übrige Props von `<button>`/`<a>` **einschliesslich `data-*`** (Dialoge setzen den Startfokus über `[data-cancel]`/`[data-confirm]`), `ref` | `.btn` |
| `Dialog` | `title`, `onClose`, `footer`, `width`, `role: 'dialog' \| 'alertdialog'`, `initialFocus`, `onSubmit`, `dismissable`; Fokusfalle, Esc, Fokus zurück | `ui/Overlay.tsx` (`Modal`, `Confirm` darauf aufgebaut) |
| `Menu` | `label`, `button`, `buttonLabel`, `fixed`, `children(close)`; Einträge `MenuItem` mit `why` (gesperrt mit Grund) | `ui/MenuButton.tsx` |
| `Table` | Props von `<table>` plus `stack?: boolean` (unter 760 px gestapelt); Inhalt (`thead`, `tbody`, Zellen) schreibt die Seite selbst wie heute, Zellen mit `iam-hide-narrow` bzw. `iam-label-narrow` | `.tbl`, `.stack-tbl` |
| `Icon` | `name`, `className` | eigener Satz |
| `toast` | `{ show(text, { tone?, action?, ms? }), error(err, prefix?) }` (gleich wie Assets `useToast()`) | eigene `aria-live`-Meldung |

`Confirm`, `Sheet`, `Picker`, Tabs und Rollenauswahl bleiben Teil des Pakets (sie bauen auf `Dialog`, `Button` auf); die
Liste der austauschbaren Teile bleibt bewusst kurz. `Table` ist bewusst keine Datentabelle mit Spaltenmodell: Die
Seiten aus Assets werden übernommen, nicht neu geschrieben, deshalb ersetzt `Table` nur das `<table>`-Element mit den
Klassen für Rahmen und Stapeln.

## 3. Texte

- Alle sichtbaren Texte des Pakets stehen in `src/texts/de.ts` und `src/texts/en.ts` unter Schlüsseln `iam.<bereich>.<text>`
  (z. B. `iam.session.expired.title`, `iam.members.invite`, `iam.missing.right`). Deutsch ist Quelle und Standard; `de`
  enthält die heutigen Texte von Assets wörtlich, damit Assets nach der Umstellung gleich aussieht und seine E2E-Tests
  ungeändert bestehen.
- Platzhalter `{name}`; Mehrzahl über `Intl.PluralRules` mit Schlüsseln `…_one`/`…_other`. Datum und Zahlen über `Intl`
  mit `locale`.
- `texts={{ de: {…}, en: {…}, fr: {…} }}` überschreibt einzelne Schlüssel und ergänzt Sprachen; fehlt ein Schlüssel in
  einer Sprache, gilt `de`. Der Typ `IamTextKey` macht Tippfehler beim Überschreiben zum Typfehler.
- Labels und Beschreibungen von Rechten, Rollen, Scopes, Ressourcentypen kommen nur aus dem Katalog. Das Paket fragt
  ihn mit `Accept-Language: <locale>` ab (V2; Antwort mit `Vary: Accept-Language`) und führt die Sprache im
  Abfrageschlüssel (`['iam', 'catalog', locale]`).
- Fehlertexte der API (`title`, `detail`) zeigt das Paket unverändert; nur Rückfalltexte je Status sind Schlüssel.
- Tests: Du-Form (kein «Sie/Ihr/Ihnen» als Anrede), kein «ß», Begriffe nach 11.2 (kein «Mandant», «Tenant», «ACL»,
  «Principal» in sichtbaren Texten) über alle Schlüssel und über die JSX-Texte (wie `ui/texts.test.ts`,
  `ui/terms.test.ts` in Assets); `en` hat dieselben Schlüssel und Platzhalter wie `de`.

## 4. Abhängigkeiten

| Paket | Art | Entscheid und Begründung |
|---|---|---|
| `react`, `react-dom` `^19` | peer | Vorgabe; Portale für Dialoge |
| `@tanstack/react-query` `^5` | peer | **Übernommen.** Assets nutzt es überall; das Paket muss beim Wechsel der Organisation den **Cache der App** leeren (sonst sind Daten der vorigen Organisation sichtbar, 11.1) und nach Änderungen gezielt invalidieren (Rollen, Mitglieder, Katalog). Mit eigenen Abruf-Hooks bräuchte es dafür eine Brücke zur App und doppelte Logik für Wiederholung, Abbruch und Platzhalter (`keepPreviousData` in «Rechte prüfen»). Apps ohne Query erhalten einen paketeigenen `QueryClient`, dann leert der Wechsel nur die Daten des Pakets und die App bekommt `onTenant`. |
| Router (`@tanstack/react-router`, React Router) | keine | **Nicht übernommen.** Typisierte Routen von TanStack lassen sich nicht aus einem Paket in den Routenbaum der App registrieren, und eine App mit React Router bräuchte sonst zwei Router. Adapter mit vier Funktionen (1.6). |
| `openapi-fetch`, `openapi-typescript` | keine | **Nicht übernommen.** Das Paket darf nicht von den erzeugten Typen von Assets abhängen. Eigener Client (`fetch`, rund 80 Zeilen wie `api/client.ts`) mit von Hand geschriebenen Typen des Vertrags in `src/contract.ts`; ein Test vergleicht sie mit einem Auszug der OpenAPI von Assets (Abschnitt 6). |
| `@fontsource/*`, Icons | keine | Schrift und Symbole sind Sache der App (`--iam-font`, `components.Icon`). |
| Laufzeit sonst | keine | `dependencies` bleibt leer. |
| Entwicklung | dev | `typescript`, `vitest`, `jsdom`, `@testing-library/{react,user-event,jest-dom}`, `axe-core`, `vite`, `@vitejs/plugin-react` (nur Testseite), `@playwright/test`, `@axe-core/playwright`, `@types/react(-dom)`, `openapi-typescript` (nur Vertragstest); Versionen exakt wie in Assets `web/package.json` |

## 5. Barrierefreiheit

Ziel WCAG 2.2 AA, gleich wie Assets (`docs/oberflaeche.md` › Bedienung und Barrierefreiheit):

- **axe** ohne `serious`/`critical` auf allen Seiten und Dialogen, hell und dunkel, bei 1440 und 390 px.
- **Tastatur**: Menü-Button nach ARIA-Muster (Pfeile, Pos1/Ende, Esc, Fokus zurück), Reiter nach Muster Tabs, Dialoge
  mit Fokusfalle, Startfokus auf dem ersten sichtbaren Element, Esc auch nach verlorenem Fokus, `Confirm` mit `danger`
  startet auf «Abbrechen»; Picker als Combobox/Listbox; sichtbarer Fokus (`--iam-focus`).
- **Schmal**: unter 760 px gestapelte Tabellen (`Table stack`), kein waagrechtes Scrollen bei 390 px (Test misst
  `scrollWidth` der Seite), Rollenmatrix ohne waagrechtes Scrollen.
- **Formulare**: Prüfung beim Absenden, Meldung am Feld (`aria-invalid`, `aria-describedby`), Fokus dorthin; Fehler im
  Dialog, der offen bleibt.
- **Sonst**: gesperrt mit Grund statt ausgeblendet (`aria-disabled` + Beschreibung), zugängliche Namen «Mehr zu <Name>»,
  `prefers-reduced-motion`, `forced-colors`, Überschriftenebenen einstellbar (`headingLevel`), weil das Paket die
  Seitenstruktur der App nicht kennt.
- Lint: `eslint-plugin-jsx-a11y` wie in Assets, sobald das Repository ESLint einführt (heute nur `tsc`); bis dahin
  decken axe in Vitest und Playwright das ab.

## 6. Teststrategie

| Ebene | Werkzeug | Inhalt |
|---|---|---|
| Einheit/Komponente | Vitest + jsdom + Testing Library, `axe-core` je Komponente | Die Tests von Assets für diese Teile (rund 150 Fälle: `auth/*.test.tsx`, `shell/rights.test.tsx`, `ui/{components,rights,rights-overview,texts,terms}.test.*`, `features/admin*.test.tsx`, `features/acl/acl.test.tsx`), übernommen und produktneutral: Beispielkatalog einer Notiz-App (Rechte `note:*` plus reservierte, Rollen `editor`, `viewer`, `org-admin`, Ressource `folder` → `note`) statt des Assets-Katalogs |
| Vertrag | `tsc` + Vitest | `src/contract.ts` gegen einen Auszug der OpenAPI von Assets (`test/fixtures/openapi-iam.json`: `/auth/*`, `/v1/authz/catalog`, `/v1/acl*`, `/v1/roles*`, `/v1/admin/*`, `/v1/platform/*`, `/v1/people*`, ohne Beschreibungen). Daraus erzeugt `openapi-typescript` Typen (`test/fixtures/openapi-iam.d.ts`, ein Test prüft, dass sie aktuell sind); `test/contract.check.ts` weist jede Antwort der OpenAPI dem Typ des Pakets zu und jeden Anfragekörper des Pakets dem Typ der OpenAPI – die Typprüfung schlägt fehl, wenn der Vertrag abweicht. `/auth/me` hat in Assets kein Schema; `Me` folgt Spezifikation 5.1. Der Auszug wird bei Vertragsänderungen erneuert, später aus `@vollholz/iam` erzeugt |
| Oberfläche im Browser | Playwright (Chromium) + `@axe-core/playwright` | Testseite (`test/e2e/app`, Vite) mit allen Seiten und nachgebildeter API über `page.route` (gleiche Nachbildung wie `testing/mockIamApi`): axe hell/dunkel, 390 px ohne waagrechtes Scrollen, Tastaturabläufe (Kontomenü, Einladen, Rollen setzen, Zugriffsregel anlegen), Organisation je Tab mit zwei Seiten im selben Kontext, Sitzung abgelaufen |
| Gegen echten Stack | in Assets | Die E2E-Tests von Assets (`members`, `rollen`, `rechte-zugriff`, `organisation-je-tab`, `mandantentrennung`, `ui`) bleiben dort und laufen nach der Umstellung unverändert grün (Abnahme Phase 2) |

- `npm test` im Paket: Vitest; `npm run e2e`: Playwright. Root-CI: `npm test` läuft schon über alle Workspaces; für E2E
  kommt ein Schritt dazu (Chromium installieren, `npm run e2e -w @vollholz/iam-web`), in Sessions mit
  `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`.
- Testhilfen für Apps (`@vollholz/iam-web/testing`) sind selbst getestet und ersetzen in Assets `test/utils.tsx`
  (`renderWith`, `StaticSession`, `ME`).

## 7. Plan der Teil-PRs

Jeder PR mit Tests, `typecheck`, `build`, `test` grün; Version `0.1.0` und `private: true` bis zum letzten.

| # | PR | Inhalt | Tests |
|---|---|---|---|
| 1 | Entwurf | dieses Dokument (identity-kit#4) | – |
| 2a | Gerüst und Client | Workspace, `package.json`, Build (`tsc` + `styles.css`), Vitest; `contract.ts`, `ApiError`, Client (`iamFetch`, `authFetch`, `iamMiddleware`, `reportStatus`), Organisation je Tab (mit `sub`, `legacyTabKey`), Formatierung, Texte (Mechanik, `de`, `en`); Nachführung dieses Entwurfs | Client, Organisation je Tab, Formatierung, Texte (Du-Form, ß, Begriffe), Vertrag, Paket lässt sich laden |
| 2b | Grundkomponenten | Theming (`styles.css` in `@layer iam`), Button, Dialog/Confirm/Sheet (Fokusfalle), Menu/MenuItem, Table, Icon, Toast, Zustände (`Loading`, `Empty`, `ErrorBox`, `ErrorState`, `NotFound`), Picker; Testseite + Playwright | `ui/components.test` (15 Fälle), axe, Vorrang der App-Variablen im Browser |
| 2c | Provider und Sitzung | `IamProvider` (Gates, Auswahlseite, «nicht verfügbar», «Sitzung abgelaufen», `/abgemeldet`), Router-Adapter mit Standard, `useIam`, `useAuthz` (Sprache, `roleGroups`, `roleGroupProblems`), `useRoles`, `useResourceCan`, `useIamFetch`, `Can`, `iamKeys`, `testing` (`StaticIam`, `mockIamApi`, Beispielkatalog) | `auth/session`, `auth/organisation`, `auth/authz`, Router, Testhilfen; Browser: Zustände der Sitzung mit axe |
| 3 | Rechte-Bausteine | `Requires`, `RequiresPlatformAdmin` (brauchen `NoPermission`), `useAdminStatus`, `AdminHead`, `MissingRight`, `NoPermission`, `RightsOverview`, `RoleMatrix`/`RoleCompare`, `MyRightsDialog`, `AccountMenu`, `OrgName`, `OrgSwitchItems`; danach **Probe in Assets** (nur lokal über `scripts/local-registry.ts`: Sitzung, Kontomenü, Rechte-Bausteine umgestellt, Tests und Screenshots), Ergebnis im PR | `rights`, `rights-overview`, `shell/rights`, Kontomenü per Tastatur |
| 4 | Mitglieder und Rollen | `MembersPage`, `RolesPage`, `iamRoutes`, `IamNav` | `members`, `roles-page`, `roles-dialog`, Teile von `admin.test`, E2E Einladen/Rollen |
| 5 | Maschinen-Clients, Anmeldung, Organisationen (geteilt: 5a Maschinen-Clients und Organisationen, 5b Anmeldung) | `ClientsPage`, `EntraPage` + Rückkehrseiten, `OrganizationsPage`/`OrganizationPage`; in `MembersPage` «Person hinzufügen» aus Entra ID (mit `features.entra`) | `clients`, `entra`, `entra-add`, übrige `admin.test`, E2E |
| 6 | Zugriff | `AccessPage` (Regeln, Dialog mit Vorschau, «Rechte prüfen»), `AclHint`, `resources`- und `people`-Adapter, `PersonName` | `acl.test` (40 Fälle), E2E Zugriffsregel |
| 7 | Freigabe 0.1.0 | README (Einbinden, Beispiel), Migrationshinweis für Assets, CI-Schritt E2E, `private` entfernen → Release veröffentlicht `0.1.0` | `npm pack` enthält `dist`, `styles.css`, Typen |

Reihenfolge 2b vor 2c (abweichend von der Freigabe «Gerüst+Client / Provider+Sitzung / Grundkomponenten»): Der Provider
braucht Dialog («Sitzung abgelaufen»), Zustände und Knöpfe; so wird jeder PR mit seinen eigenen Teilen getestet, statt
vorläufige Platzhalter zu bauen.

## 8. Umstellung von Assets (Phase 2)

Eigener PR in vollholz/assets nach 0.1.0, Paket gepinnt (`"@vollholz/iam-web": "0.1.0"`, Bezug nach
[docs/ausrollen.md](../../../docs/ausrollen.md)):

1. `main.tsx`: `SessionProvider` → `IamProvider` mit diesen Props (vollständig):

   | Prop | Wert in Assets |
   |---|---|
   | `product` | `"Assets"` |
   | `brand` | Marke mit Symbol `layers` (heute in `Gate`) |
   | `locale` | `"de"` |
   | `texts` | `{ de: { 'iam.rights.rulesNote': <heutiger RULES_NOTE> } }`; sonst keine (die deutschen Texte des Pakets sind die von Assets) |
   | `queryClient` | der bestehende `QueryClient` aus `main.tsx` |
   | `router` | TanStack-Router-Adapter (1.6) |
   | `paths` | keine (Standard = heutige Pfade) |
   | `features` | `{ acl: true, entra: true, platform: true }` |
   | `legacyTabKey` | `"assets.tab.org"` |
   | `components` | `{ Icon }` (Assets-Symbole), `toast` aus `ui/Toasts.tsx`; Knopf, Dialog, Menü, Tabelle aus dem Paket |
   | `roleGroups`, `roleIcons` | heutige `ROLE_GROUPS`, `ROLE_ICON` |
   | `resources` | Schema, Typ (Kette Schema › Obertypen), Verbindung, Credential; `noGrant: ['object']` |
   | `people` | keine (Standard `/v1/people`) |
   | `onTenant` | `me => setPrefScope(me.person.subject, me.tenant?.id ?? null)` |
   | `onLogout` | `clearPersonalPrefs` |

   Dazu `api.use(iamMiddleware)` statt der eigenen Middleware in `api/client.ts`; `ApiError` aus dem Paket.
2. `Register` mit dem bestehenden Typ `Permission`; der Test «Typ `Permission` = Katalog» bleibt in Assets.
3. `styles`: `@vollholz/iam-web/styles.css` importieren und `--iam-*` auf die Tokens von `base.css` abbilden; Klassen
   der übernommenen Teile aus `admin.css`, `acl.css`, `shell.css` entfernen.
4. `router.tsx`: Routen der Seiten aus `iamRoutes`, `requires()` → `Requires`; `Rail.tsx` nutzt `IamNav` oder
   `iamRoutes`; `CommandPalette` nutzt `OrgSwitchItems`.
5. Löschen: `auth/{session.tsx,authz.ts,tabOrg.ts,resource-can.ts}`, `shell/{UserMenu,MyRights}.tsx`,
   `ui/{MissingRight,RightsOverview,RoleMatrix,org}.tsx`, `features/{admin,acl}/*`, `api/{admin,roles}.ts`; `ui/
   {Overlay,MenuButton,Picker,states,AdminHead}` bleiben, solange andere Seiten von Assets sie nutzen (oder werden durch
   die Exporte des Pakets ersetzt). Importe der übrigen Features auf das Paket umstellen (`useSession` → `useIam`).
6. Organisation je Tab: `legacyTabKey="assets.tab.org"` übernimmt die Wahl offener Tabs einmal nach `iam.tab.org`.
7. Tests: übernommene Tests in Assets entfernen, `test/utils.tsx` auf `@vollholz/iam-web/testing`; E2E von Assets
   unverändert grün, dazu `npm run check` und axe wie bisher.

**Abnahme «ohne sichtbare Veränderung»:** Ein Playwright-Lauf nimmt vor der Umstellung (Stand `main`) und danach
Screenshots derselben Ansichten auf – Kontomenü, «Meine Rollen und Rechte», Mitglieder mit Rollendialog und Einladen,
Rollen, Maschinen-Clients, Anmeldung, Zugriff (beide Reiter, Dialog), Organisationen, «Recht fehlt», «Sitzung
abgelaufen», Auswahlseite, «Du bist abgemeldet» – je 1440 und 390 px, hell und dunkel, und vergleicht sie
(`toHaveScreenshot`, kleine Toleranz für Kantenglättung). Jede Abweichung wird behoben oder im PR mit Bild begründet.

## 9. Fragen zum Vertrag

Entscheide der Hauptsession bei der Freigabe (2026-10-22): V1 ja (`/v1/people` mit `q` und `ids` bis 100 gehört zum
Vertrag, Adapter trotzdem); V2 ja, mit `Vary: Accept-Language` und Sprache im Abfrageschlüssel; V3 Prop `roleGroups`,
bis der Katalog es liefert, mit Test «alle Schlüssel im Katalog»; V4 kein neues Feld, `features.entra` als
App-Schalter und `enabled` aus `GET /v1/admin/entra`; V5 ja. Die Spezifikation zieht die Hauptsession nach.

| # | Frage | Vorschlag |
|---|---|---|
| V1 | Personenverzeichnis `GET /v1/people` (Suche, Namen zu Principal-IDs) braucht die Seite «Zugriff» (Person in einer Zugriffsregel, «Rechte prüfen»). Es steht nicht in der Liste des Vertrags (15.1). | Teil des Standards (`@vollholz/iam` liefert es, da `principal` eine IAM-Tabelle ist); bis dahin `people`-Adapter mit diesem Standard |
| V2 | Labels des Katalogs je Sprache (15.2 «aus dem Katalog (je Sprache)»): wie wählt `GET /v1/authz/catalog` die Sprache? | `Accept-Language` (das Paket sendet `locale`), Antwort mit `Content-Language`; ohne Übersetzung Deutsch |
| V3 | Gruppen und Reihenfolge der Rollen in Rollendialog und Matrix sind in Assets fest im Frontend (`ROLE_GROUPS`). Das widerspricht «keine eigenen Listen» (7.2). | Katalog um `roleGroups` ergänzen (`defineCatalog`), bis dahin Prop `roleGroups` |
| V4 | Ist die Anmeldung über Entra angeboten (KANN, 9.4)? Die Oberfläche kann es heute nicht erkennen. | Feld `entra: boolean` in `GET /v1/admin/status`; bis dahin `features.entra` |
| V5 | `grantedPermissions` steht in 7.1, aber nicht in der Feldliste von `/auth/me` (5.1). | in 5.1 ergänzen (optional) |
