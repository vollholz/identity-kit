# Entwurf: `@vollholz/iam-web`

Stand 2026-10-22 · Status: **Entwurf zur Freigabe** · Spezifikation: [Kap. 11](../../../docs/spezifikation.md#11-oberfläche),
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
| `@vollholz/iam-web` | `IamProvider`, Hooks, Rechte-Bausteine, Routen-Guard, Kontomenü, Grundkomponenten | Kern, den jede Seite der App braucht |
| `@vollholz/iam-web/pages` | Verwalten-Seiten (Mitglieder, Rollen, Maschinen-Clients, Anmeldung, Zugriff, Organisationen) und `iamRoutes` | Die App lädt sie per `lazy()` nach; der Kern bleibt klein |
| `@vollholz/iam-web/testing` | `StaticIam` (feste Sitzung ohne Server), `mockIamApi` (fetch-Ersatz für `/auth/*` und `/v1/…` des Vertrags), Beispiel-`Me` und Beispielkatalog | Tests der App ohne eigene Nachbildung (heute `web/src/test/utils.tsx` in Assets) |
| `@vollholz/iam-web/styles.css` | Struktur und Aussehen aus `--iam-*` | Einmal in der App importieren |

Ausgeliefert wird ESM mit `.d.ts` (Build mit `tsc`, wie `iam-testkit`), CSS als Datei. Kein Bundler im Paket.

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
  paths={{ members: '/verwalten/mitglieder', … }} // optional, Standard wie Assets (1.6)
  components={{ Button, Dialog, Menu, Table, Icon, toast }} // optional (2.2)
  roleGroups={[…]}                          // optional: Gruppen im Rollendialog (Darstellung)
  roleIcons={{ editor: 'edit' }}            // optional: Symbol je vordefinierter Rolle
  resources={noteResources}                 // nur mit Zugriffsregeln (1.7)
  people={peopleAdapter}                    // optional, Standard /v1/people (9, Frage V1)
  brand={<Logo />}                          // optional: Marke auf Auswahl- und Abmeldeseite
>
  <App />
</IamProvider>
```

Verhalten wie `SessionProvider` in Assets (Spezifikation 11.1):

- Start mit `GET /auth/me` (mit `X-Tenant` der Organisation des Tabs); 401 → `/auth/login?returnTo=<adresse>`.
- Mehrere Organisationen ohne Wahl → Auswahlseite; Organisation des Tabs nicht mehr verfügbar → Hinweis mit Wechsel
  und «Neu laden», nie Daten einer anderen Organisation.
- `/abgemeldet` (Pfad aus `paths.loggedOut`) → öffentliche Seite «Du bist abgemeldet», ohne `/auth/me`.
- Jede 401 öffnet «Sitzung abgelaufen» mit «Erneut anmelden» (Eingaben bleiben); jede 403 lässt `/auth/me` prüfen.
- Anderer Mandant im Tab → Cache der App ausser `/auth/me` leeren (deshalb der gemeinsame `QueryClient`, Abschnitt 4).
- Abmelden: `POST /auth/logout`, Organisation des Tabs löschen, Hook `onLogout` der App (z. B. persönliche
  Einstellungen löschen, in Assets `clearPersonalPrefs`).
- Organisation je Tab in `sessionStorage` unter `iam.tab.org` (Assets: `assets.tab.org`, Übernahme Abschnitt 8).

### 1.3 Hooks

| Hook | Liefert | Herkunft Assets |
|---|---|---|
| `useIam()` | `me`, `can(p)`, `canSomewhere(p)`, `switchOrg(alias)`, `logout()`, `orgName` (Name der Organisation des Tabs) | `useSession`, `ui/org.ts` |
| `useAuthz()` | Katalog mit eigenen Rollen: `permission`, `permLabel`, `roleLabel`, `rolesWith`, `scopeText`, `resourceLabel`, `groupRoles` | `auth/authz.ts` |
| `useResourceCan()` | `(resource, capability, perm) => boolean` nach `can` der Ressource, sonst Mandantenebene | `auth/resource-can.ts` |
| `useIamFetch()` | `fetch` mit Cookie, `X-Tenant`, `X-CSRF-Token`, problem+json → `ApiError`, 401/403-Meldung; für eigene Aufrufe der App | `api/client.ts` |
| `useIamText()` | `t(key, vars)` (Abschnitt 3) | neu |
| `useAdminStatus()`, `useRoles()`, `useMembers(alias)`, `useClientGrants(alias)` | Daten der Verwaltung, für eigene Anzeigen der App | `api/admin.ts`, `api/roles.ts` |

Ausserdem ohne React: `ApiError`, `describeError`, `withTenant(url)` (Links mit `?x-tenant=`), `tenantHeaders()`
(`X-Tenant`/`X-CSRF-Token` für eigene Clients wie `openapi-fetch` der App), `ADMIN_ROLE`, `PLATFORM_ADMIN`,
`isCustomRole`.

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
| `<RightsOverview roles permissions scopes admin rulesNote>`, `rightsModel()` | Rechte-Übersicht für alle Blickwinkel (11.2) |
| `<RoleMatrix>`, `<RoleCompare>` | Rechtegruppe × Rolle, ohne waagrechtes Scrollen |
| `<MyRightsDialog>` | «Meine Rollen und Rechte» |
| `<AccountMenu avatar? extraItems?>` | Kontomenü: Person, Organisation, «Meine Rollen und Rechte», Organisation wechseln, Abmelden; die App ergänzt eigene Einträge |
| `<OrgName>`, `<OrgSwitchItems>` | Name der Organisation für die Kopfzeile; Einträge «Zu «X» wechseln» für die Befehlspalette der App |
| `<AclHint resourceType resourceId>` | «Zugriff eingeschränkt (n)» an einer Ressource (nur mit Zugriffsregeln) |
| `<NotFound>`, `<ErrorState>`, `<ErrorBox>`, `<Loading>`, `<Empty>` | Zustände wie in Assets, 404-Text nach 11.1 |

### 1.5 Seiten

Aus `@vollholz/iam-web/pages`; jede Seite prüft ihr Recht selbst nicht, das macht `Requires` (wie heute in Assets).

| Seite | Pfad (Standard) | Recht | Herkunft Assets |
|---|---|---|---|
| `MembersPage` | `/verwalten/mitglieder` | `members:admin` | `features/admin/Members.tsx` |
| `RolesPage` | `/verwalten/rollen` | `members:admin` (Seite), lesen `tenant:read` | `Roles.tsx` |
| `ClientsPage` | `/verwalten/maschinen-clients` | `members:admin` | `Clients.tsx` |
| `EntraPage`, `EntraConsentReturn`, `EntraTestReturn` | `/verwalten/anmeldung`, `…/zustimmung`, `…/test` | `members:admin` bzw. API prüft | `EntraLogin.tsx` |
| `AccessPage` | `/verwalten/zugriff` | `acl:read` | `features/acl/*` |
| `OrganizationsPage`, `OrganizationPage` | `/verwalten/organisationen[/:alias]` | `platform-admin` | `Organizations.tsx` |

Dazu `iamRoutes`: Liste `{ id, path, perm, title, icon, load }` aller Seiten, aus der die App ihre Routen und ihre
Navigation erzeugt, und `<IamNav>` als fertige Gruppe «Zugang» (Mitglieder, Rollen, Anmeldung, Maschinen-Clients,
Zugriff, Organisationen – je nach Recht und `features`). Welche Seiten es gibt, steuert die App mit
`features={{ acl, entra, platform }}` (Standard: `acl` = Katalog enthält `acl:read`; `entra` = aus; `platform` = an).

Beispiel TanStack Router (Assets):

```tsx
for (const r of iamRoutes) createRoute({ getParentRoute: () => adminRoute, path: r.path.replace('/verwalten', ''),
  component: lazyRouteComponent(r.load, 'default') });
```

Beispiel React Router: `<Route path={r.path} lazy={async () => ({ Component: (await r.load()).default })} />`.

### 1.6 Router und Pfade

Das Paket hängt von **keinem** Router ab. Es braucht drei Dinge, die die App über `router` liefert:

```ts
interface IamRouter {
  Link: ComponentType<{ to: string; className?: string; children: ReactNode; 'aria-current'?: 'page' }>;
  navigate(to: string, opts?: { replace?: boolean }): void;
  useSearchParams(): [URLSearchParams, (next: URLSearchParams, opts?: { replace?: boolean }) => void];
  usePathname(): string;
}
```

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
  /** Kette über der Ressource (ohne sie selbst und ohne tenant), für Vorschau und AclHint. */
  chain?(type: string, id: string): { type: string; id: string; label: string }[];
  /** Auf welchen Typen keine Freigabe möglich ist (Blatt der Kette, Spezifikation 7.1); Standard: Blatt. */
  noGrant?: string[];
  /** Hinweis in der Rechte-Übersicht (Assets: «… für einzelne Schemas, Typen oder Verbindungen …»). */
  rulesNote?: string;
}
```

### 1.8 Was produktneutral wird

| In Assets fest | Im Paket |
|---|---|
| `Permission` als Union aller 32 Rechte | `Register` der App (1.3) |
| `ROLE_GROUPS` (Verwaltung/Arbeit/Kontrolle mit Assets-Rollen), `ROLE_ICON` | Props `roleGroups`, `roleIcons`; Standard: «Gesamte Organisation» (`org-admin`), «Rollen» (übrige vordefinierte), «Eigene Rollen» |
| `RULES_NOTE` nennt Schemas, Typen, Verbindungen | Text `iam.rights.rulesNote`, die App setzt ihn über `resources.rulesNote` oder `texts` |
| Ressourcennamen aus `useCatalog`, `useConnections`, `useCredentials`; Regel «keine Freigabe auf `object`» | `resources` (1.7) |
| `UserChip` und Personensuche aus `/v1/people` | `people`-Adapter mit Standard `/v1/people` (Frage V1) |
| Marke «Assets» mit Symbol `layers` auf Auswahl- und Abmeldeseite | `product`, `brand` |
| Icons der App (`ui/icons.ts`, 70 Symbole) | eigener kleiner Satz (rund 20 SVG-Pfade) oder `components.Icon` |
| Toasts der App (`ui/Toasts.tsx`) | `components.toast`, sonst eigene Meldungen (`aria-live`) |
| Personen-Einstellungen (`ui/prefs.ts`) | nicht im Paket; Hooks `onTenant(me)`, `onLogout()` |

## 2. Theming und Grundkomponenten

### 2.1 CSS-Variablen

Die Bausteine bringen kein Erscheinungsbild der App mit. `styles.css` enthält Struktur (Raster, Stapeln unter 760 px,
Menüs, Dialoge, Tabellen) und färbt nur über `--iam-*`; alle Klassen tragen den Präfix `iam-`, damit nichts mit der App
kollidiert. Die Werte sind neutral vorbelegt (hell und dunkel nach `prefers-color-scheme`), die App setzt sie aus
ihren Tokens, z. B. Assets:

```css
:root { --iam-accent: var(--accent); --iam-surface: var(--surface); --iam-text: var(--fg); … }
```

| Variable | Zweck |
|---|---|
| `--iam-font`, `--iam-font-mono`, `--iam-font-size` | Schrift |
| `--iam-bg`, `--iam-surface`, `--iam-surface-2`, `--iam-hover` | Flächen |
| `--iam-text`, `--iam-text-2`, `--iam-text-3` | Text (stark, normal, leise; `--iam-text-3` muss 4.5:1 auf `--iam-surface` erreichen) |
| `--iam-line`, `--iam-line-2` | Linien |
| `--iam-accent`, `--iam-accent-text`, `--iam-accent-soft` | Akzent, Text darauf, Hintergrund gewählter Zeilen |
| `--iam-ok`, `--iam-warn`, `--iam-bad`, `--iam-info` und je `…-soft` | Status (erlaubt, fehlt, verboten, Hinweis) |
| `--iam-focus` | Fokusring |
| `--iam-radius`, `--iam-radius-s`, `--iam-shadow`, `--iam-space` | Form, Schatten, Grundabstand |

Hell/dunkel steuert die App: sie setzt die Variablen in ihrem dunklen Thema (Assets: `[data-theme=dark]`). In
`forced-colors` nutzen die Bausteine Systemfarben.

### 2.2 Austauschbare Grundkomponenten

Über `components` ersetzt die App einzelne Grundkomponenten durch ihre eigenen; ohne Angabe gelten die des Pakets
(übernommen aus Assets `ui/`). Verhalten (Fokus, Tastatur, ARIA) ist Teil des Vertrags jeder Komponente; eigene
Komponenten müssen es erfüllen, die Tests des Pakets prüfen das mit den Standard-Komponenten.

| Schlüssel | Vertrag (Props) | Standard aus |
|---|---|---|
| `Button` | `variant: 'primary' \| 'ghost' \| 'danger' \| 'link'`, `size?: 'sm'`, `icon?`, `busy?` (→ `aria-disabled`, bleibt fokussierbar), übrige Button-Props, `ref` | `.btn` |
| `Dialog` | `title`, `onClose`, `footer`, `width`, `role: 'dialog' \| 'alertdialog'`, `initialFocus`, `onSubmit`, `dismissable`; Fokusfalle, Esc, Fokus zurück | `ui/Overlay.tsx` (`Modal`, `Confirm` darauf aufgebaut) |
| `Menu` | `label`, `button`, `buttonLabel`, `fixed`, `children(close)`; Einträge `MenuItem` mit `why` (gesperrt mit Grund) | `ui/MenuButton.tsx` |
| `Table` | `caption`, `columns: { key, label, hideBelow?: 760, className }`, `rows`, `rowKey`, `stack` (unter 760 px gestapelt) | `.tbl`, `.stack-tbl` |
| `Icon` | `name`, `className` | eigener Satz |
| `toast` | `{ ok(text), error(err, title) }` | eigene `aria-live`-Meldung |

`Confirm`, `Sheet`, `Picker`, Tabs und Rollenauswahl bleiben Teil des Pakets (sie bauen auf `Dialog`, `Button` auf); die
Liste der austauschbaren Teile bleibt bewusst kurz.

## 3. Texte

- Alle sichtbaren Texte des Pakets stehen in `src/texts/de.ts` und `src/texts/en.ts` unter Schlüsseln `iam.<bereich>.<text>`
  (z. B. `iam.session.expired.title`, `iam.members.invite`, `iam.missing.right`). Deutsch ist Quelle und Standard; `de`
  enthält die heutigen Texte von Assets wörtlich, damit Assets nach der Umstellung gleich aussieht und seine E2E-Tests
  ungeändert bestehen.
- Platzhalter `{name}`; Mehrzahl über `Intl.PluralRules` mit Schlüsseln `…_one`/`…_other`. Datum und Zahlen über `Intl`
  mit `locale`.
- `texts={{ de: {…}, en: {…}, fr: {…} }}` überschreibt einzelne Schlüssel und ergänzt Sprachen; fehlt ein Schlüssel in
  einer Sprache, gilt `de`. Der Typ `IamTextKey` macht Tippfehler beim Überschreiben zum Typfehler.
- Labels und Beschreibungen von Rechten, Rollen, Scopes, Ressourcentypen kommen nur aus dem Katalog (Frage V2 zur
  Sprache).
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
| Entwicklung | dev | `typescript`, `vitest`, `jsdom`, `@testing-library/{react,user-event,jest-dom}`, `axe-core`, `vite`, `@vitejs/plugin-react` (nur Testseite), `@playwright/test`, `@axe-core/playwright`, `@types/react(-dom)`; Versionen exakt wie in Assets `web/package.json` |

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
| Vertrag | Vitest | `src/contract.ts` gegen einen Auszug der OpenAPI von Assets (`test/fixtures/openapi-iam.json`: nur `/auth/*`, `/v1/authz/catalog`, `/v1/acl*`, `/v1/roles*`, `/v1/admin/*`, `/v1/platform/*`) – Felder und Typen der Antworten, die das Paket liest; der Auszug wird bei Vertragsänderungen erneuert, später aus `@vollholz/iam` erzeugt |
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
| 1 | Entwurf | dieses Dokument | – |
| 2 | Gerüst und Sitzung | Workspace, `package.json`, Build, Vitest, Testseite + Playwright; `contract.ts`, Client (`useIamFetch`, `ApiError`), Organisation je Tab, `IamProvider` (Gates, «Sitzung abgelaufen», `/abgemeldet`), `useIam`, `useAuthz`, `useResourceCan`, `Can`, `Requires`, Texte (`de`, `en`), Theming (`styles.css`), Grundkomponenten (Button, Dialog/Confirm/Sheet, Menu, Table, Icon, Toast), Zustände, `testing` | Client, Sitzung, Organisation je Tab, Komponenten (Fokus), Texte, Vertrag, axe |
| 3 | Rechte-Bausteine | `MissingRight`, `NoPermission`, `RightsOverview`, `RoleMatrix`/`RoleCompare`, `MyRightsDialog`, `AccountMenu`, `OrgName`, `OrgSwitchItems` | `rights`, `rights-overview`, `shell/rights`, Kontomenü per Tastatur |
| 4 | Mitglieder und Rollen | `MembersPage` (Einladen, Rollen, Entfernen, Einladung erneut/zurückziehen, Entra-Personen), `RolesPage` (eigene Rollen), `iamRoutes`, `IamNav` | `members`, `roles-page`, `roles-dialog`, Teile von `admin.test`, E2E Einladen/Rollen |
| 5 | Maschinen-Clients, Anmeldung, Organisationen | `ClientsPage`, `EntraPage` + Rückkehrseiten, `OrganizationsPage`/`OrganizationPage` | `clients`, `entra`, `entra-add`, übrige `admin.test`, E2E |
| 6 | Zugriff | `AccessPage` (Regeln, Dialog mit Vorschau, «Rechte prüfen»), `AclHint`, `resources`- und `people`-Adapter | `acl.test` (40 Fälle), E2E Zugriffsregel |
| 7 | Freigabe 0.1.0 | README (Einbinden, Beispiel), Migrationshinweis für Assets, CI-Schritt E2E, `private` entfernen → Release veröffentlicht `0.1.0` | `npm pack` enthält `dist`, `styles.css`, Typen |

## 8. Umstellung von Assets (Phase 2)

Eigener PR in vollholz/assets nach 0.1.0, Paket gepinnt (`"@vollholz/iam-web": "0.1.0"`, Bezug nach
[docs/ausrollen.md](../../../docs/ausrollen.md)):

1. `main.tsx`: `SessionProvider` → `IamProvider` mit `product="Assets"`, `brand`, `roleGroups`/`roleIcons` (heute
   `ROLE_GROUPS`, `ROLE_ICON`), `resources` (Schema, Typ mit Schema-Kette, Verbindung, Credential; `noGrant:
   ['object']`, `rulesNote`), `components` (Assets-`Icon`, `toast` aus `ui/Toasts.tsx`), TanStack-Router-Adapter,
   `onTenant` → `setPrefScope`, `onLogout` → `clearPersonalPrefs`.
2. `Register` mit dem bestehenden Typ `Permission`; der Test «Typ `Permission` = Katalog» bleibt in Assets.
3. `styles`: `@vollholz/iam-web/styles.css` importieren und `--iam-*` auf die Tokens von `base.css` abbilden; Klassen
   der übernommenen Teile aus `admin.css`, `acl.css`, `shell.css` entfernen.
4. `router.tsx`: Routen der Seiten aus `iamRoutes`, `requires()` → `Requires`; `Rail.tsx` nutzt `IamNav` oder
   `iamRoutes`; `CommandPalette` nutzt `OrgSwitchItems`.
5. Löschen: `auth/{session.tsx,authz.ts,tabOrg.ts,resource-can.ts}`, `shell/{UserMenu,MyRights}.tsx`,
   `ui/{MissingRight,RightsOverview,RoleMatrix,org}.tsx`, `features/{admin,acl}/*`, `api/{admin,roles}.ts`; `ui/
   {Overlay,MenuButton,Picker,states,AdminHead}` bleiben, solange andere Seiten von Assets sie nutzen (oder werden durch
   die Exporte des Pakets ersetzt). Importe der übrigen Features auf das Paket umstellen (`useSession` → `useIam`).
6. Organisation je Tab: beim ersten Start `assets.tab.org` nach `iam.tab.org` übernehmen (einmalig, im Paket über
   `legacyTabKey`), damit offene Tabs ihre Organisation behalten.
7. Tests: übernommene Tests in Assets entfernen, `test/utils.tsx` auf `@vollholz/iam-web/testing`; E2E von Assets
   unverändert grün (Abnahme), dazu `npm run check` und axe wie bisher.

Erwartung: keine sichtbare Änderung in Assets, weil Texte (`de`) und Verhalten gleich bleiben; Abweichungen im
Aussehen nur dort, wo Klassen von Assets durch `iam-*` mit gleichen Tokens ersetzt werden.

## 9. Fragen zum Vertrag

| # | Frage | Vorschlag |
|---|---|---|
| V1 | Personenverzeichnis `GET /v1/people` (Suche, Namen zu Principal-IDs) braucht die Seite «Zugriff» (Person in einer Zugriffsregel, «Rechte prüfen»). Es steht nicht in der Liste des Vertrags (15.1). | Teil des Standards (`@vollholz/iam` liefert es, da `principal` eine IAM-Tabelle ist); bis dahin `people`-Adapter mit diesem Standard |
| V2 | Labels des Katalogs je Sprache (15.2 «aus dem Katalog (je Sprache)»): wie wählt `GET /v1/authz/catalog` die Sprache? | `Accept-Language` (das Paket sendet `locale`), Antwort mit `Content-Language`; ohne Übersetzung Deutsch |
| V3 | Gruppen und Reihenfolge der Rollen in Rollendialog und Matrix sind in Assets fest im Frontend (`ROLE_GROUPS`). Das widerspricht «keine eigenen Listen» (7.2). | Katalog um `roleGroups` ergänzen (`defineCatalog`), bis dahin Prop `roleGroups` |
| V4 | Ist die Anmeldung über Entra angeboten (KANN, 9.4)? Die Oberfläche kann es heute nicht erkennen. | Feld `entra: boolean` in `GET /v1/admin/status`; bis dahin `features.entra` |
| V5 | `grantedPermissions` steht in 7.1, aber nicht in der Feldliste von `/auth/me` (5.1). | in 5.1 ergänzen (optional) |
