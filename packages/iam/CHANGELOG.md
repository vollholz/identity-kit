# Changelog `@vollholz/iam`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `iam-v<version>`.

## [6.2.0] – 2026-11-07

### Hinzugefügt

- **Paket je Organisation in den Startdaten** (Konzept [Module je Organisation](../../docs/module-je-organisation.md),
  IK-5): `iam-org-bootstrap --file`/`--manifest` und `orgBootstrapFile` kennen `organizations[].package` (Schlüssel
  eines Pakets aus `packages` des Modells; `schema/init.schema.json`), `orgBootstrap` die Option `package`. Ohne Angabe
  unverändert (alle Module beim ersten Laden).
  - Das Skript kennt weder das Modell noch die Haken der App. Hat die Organisation nach dem Anlegen von Mandant und
    Admin noch keine Module, ruft es `applyPackage({ tenantId, alias, name, package })` der App – vor der Einladung,
    damit die erste Anmeldung schon die Module des Pakets sieht. Mit `@vollholz/platform` 0.9:
    `applyPackage: t => app.tenants.create(d, t.alias, t.name, { paket: t.package })`. Scheitert es, bricht der Lauf
    ohne Einladung ab; der nächste Lauf versucht es erneut.
  - Ohne `applyPackage` (Kommandozeile, `--keycloak-only`) bleibt das Paket offen; die Zusammenfassung nennt den Befehl
    der App: `Paket noch anwenden, vor der ersten Anmeldung und dem nächsten migrate (Befehl der App): tenant create <alias> --paket <key>`.
  - Hat die Organisation schon Module (zweiter Lauf, oder zuerst `tenant create --paket` der App), bleibt alles
    unverändert (`package.status: 'present'`; erneut anwenden mit `tenant modules <alias> --paket <key>`).
  - `OrgBootstrapResult` neu mit `alias` und `package: { key, status: 'applied' | 'pending' | 'present' | null }`;
    Typen `PackageTarget`, `PackageStatus`. Das Paket prüft das Skript nur auf die Form des Schlüssels; ob es im
    Modell existiert, prüft der Konformitätstest (`@vollholz/iam-testkit` 2.9.3).

## [6.1.0] – 2026-11-07

### Hinzugefügt

- **Produktmodule je Organisation** (Konzept [Module je Organisation](../../docs/module-je-organisation.md), Abschnitte
  1–5, 10): Das Modell kann ein Verzeichnis der Produktmodule tragen; der Betrieb gibt sie je Organisation frei, die
  Administration der Organisation aktiviert sie. Rechte inaktiver Module fallen im Modell der Organisation weg – für
  Oberfläche, API, Maschinen-Clients (Scopes) und MCP gleich. Ohne `modules` ändert sich nichts.
  - Modell: `defineModel({ modules, packages })` mit `ModuleDef` (`key`, `label`, `description`, `core`, `requires`
    mit «eines von» als Liste, `parts` = Teilfunktionen `modul.teil`) und `PackageDef` (`modules` oder `'*'`, `off`);
    je Recht `modul` (Modul oder `modul.teil`, ohne Angabe Kern). `defineModel` prüft: genau ein Kern, Schlüssel,
    bekannte Voraussetzungen ohne Zyklen, jedes Modul braucht (transitiv) den Kern, Teilfunktionen ohne `requires`,
    Pakete mit Kern und erfüllten Voraussetzungen, `off` nur Teilfunktionen ihrer Module, `modul` nur bekannt und nie an
    reservierten Rechten. Mit `modules` ist `features.tenantSettings` Standard `true` (Aktivieren braucht
    `tenant:admin`), `features.modules` zeigt das Verzeichnis an.
  - `Model.modules`, `packages`, `coreModule`, `moduleOf(permission)`, `activeModules` und `withModules(active)`:
    entfernt Rechte inaktiver Module aus `permissions`, Rollen, Scopes, `owner` und MCP-Werkzeugen; Rollen bleiben
    zuweisbar, eigene Rollen werden mitgefiltert und gegen das Grundmodell geprüft.
  - Katalog `GET /v1/authz/catalog`: `modules`, `packages` und je Recht `modul`; in einer Organisation nur die Rechte
    ihrer aktiven Module.
  - Migration **`iam_022_tenant_module.sql`** (läuft mit dem nächsten `migrate`): Tabelle `<schema>.tenant_module`
    (`allowed`, `active`, `active_since`, `inactive_since`, `changed_at`, `changed_by`; RLS ENABLE + FORCE, Laufzeit
    nur lesend), Funktionen `app.set_module_allowed(tenant, module, allowed)`, `app.set_module_active(module, active)`
    und `app.backfill_modules(modules)` (SECURITY DEFINER), Trigger auf `acl_version`. Der Abgleich nach den
    Migrationen (`iamMigrations({ model })`, `syncModules`) belegt jede bestehende Organisation ohne Zeilen mit allen
    Modulen erlaubt und aktiv (`tenant.module_backfill`, ohne Haken: ihre Daten bestehen schon). Eine Organisation, die
    danach ohne Zeilen erscheint (neu angelegt), wird beim ersten Laden ebenso belegt, mit `einrichten` der App je Modul
    und Teilfunktion wie beim ersten Aktivieren (`iam.modules.seed`).
  - `iam.access.load` bildet `base.withRoles(roles).withModules(active)`; `TenantAccess.modules`,
    `iam.access.modulesOf(tenantId)` (zwischengespeichert wie `modelOf`).
  - Routen (Modul `modules`, nur mit `modules` im Modell, Tag «Organisation»): `GET /v1/tenant/modules`
    (`tenant:read`; mit `tenant:admin` auch `blockers`), `PUT /v1/tenant/modules/{key}` `{ active }` (`tenant:admin`,
    `If-Match` auf `acl_version`; Schaltungen einer Organisation laufen unter der Sperre ihrer Zeile nacheinander; 403 `modul-nicht-erlaubt`, 409 `voraussetzung-fehlt`, `modul-inaktiv`,
    `abhaengig-aktiv`, `hindernisse`, `kern`), Plattform-Administration `GET
    /v1/platform/organizations/{alias}/modules` und `PUT …/{key}` `{ allowed }` (`?force=true` übergeht Hindernisse).
  - `GET /v1/me` und `GET /auth/me`: `modules` (aktive Module und Teilfunktionen).
  - Haken der App `createIam({ moduleHooks })` je Modul: `einrichten` (erstes Aktivieren), `hindernisse` (vor dem
    Deaktivieren), `nachholen` (erneutes Aktivieren, mit `seit`), alle in der Transaktion der Änderung;
    `iam.modules` (`TenantModules`) für die Plattform. Ereignisse `module.activated` und `module.deactivated`
    (`ModuleEventData` `{ module, by }`) an `IamEvents.after`; Audit `tenant.module_active` und
    `tenant.module_allowed` (Plattform-Administration auch im Protokoll der Plattform).

### Geändert

- Die Entscheidung prüft Rechte am Modell der Organisation (`AccessService.active`): ein Recht eines inaktiven Moduls
  ist überall `false`, auch über Zuständigkeit, Besitz und Scope. Ohne `modules` unverändert.
- Konformität: Apps mit `@vollholz/iam` 6.1 brauchen `@vollholz/iam-testkit` 2.9 (kennt die neuen SECURITY-DEFINER-
  Funktionen). Schema-Abzüge der App (`schemaSnapshot`) um `tenant_module` und die drei Funktionen ergänzen.

## [6.0.0] – 2026-11-05

### Breaking

- **Neuer Status `not-sent`** (`Member.status`, `MemberStatus`; `GET …/members`, Antwort von «Person einladen»):
  Konnte Keycloak die E-Mail einer Einladung nicht senden (`emailSent: false`), erscheint die Person nicht mehr als
  `invited`, sondern als `not-sent`, bis «Einladung erneut senden» gelingt (dann `invited`; scheitert es: 502, Status
  unverändert). Antwort und Dauer bleiben für neue und bestehende Konten gleich. Einladungen aus Entra ID behalten
  `invited`.
  Migration: `@vollholz/iam-web` mit `not-sent` verwenden (ältere Versionen zeigen die Mitgliederliste nicht an, sobald
  eine Einladung nicht versendet ist); eigener Code, der `status` auswertet (`switch`, Tabelle je Status), behandelt
  `not-sent` wie eine offene Einladung (zurückziehen, erneut senden).
- **Migration `iam_020_invitation_email_sent.sql`** (läuft mit dem nächsten `migrate`): Spalte
  `<schema>.member_invitation.email_sent` (Standard true). Bestand aus dem Protokoll: offene Einladungen mit Passwort,
  deren `member.invited` `emailSent: false` zeigt und die nie erneut gesendet wurden, erhalten false und erscheinen
  danach als `not-sent`. Schema-Abzüge der App (`schemaSnapshot`) um die Spalte ergänzen.

### Hinzugefügt

- **Betroffene Person im Audit** (`AuditEntry.subject`, Migration `iam_021_audit_subject.sql`, läuft mit dem nächsten
  `migrate`): Spalte `<schema>.audit_log.subject_id` (Kennung nach Wahl der App, höchstens 200 Zeichen) mit Index
  `(tenant_id, subject_id, ts)`, dazu Index `(tenant_id, actor_id, ts)`. Rückwärtskompatibel: Aufrufe ohne `subject`
  bleiben unverändert und schreiben die Spalte nicht (laufen auch vor der Migration). Die Hash-Kette bleibt gültig:
  Einträge ohne `subject_id` hashen wie bisher (Version 2), mit `subject_id` in Version 3 (`subject_id` am Ende);
  geprüft wird weiterhin mit `hash = app.audit_hash(prev_hash, l)`. Schema-Abzüge der App (`schemaSnapshot`) um Spalte,
  Indizes und den neuen Rumpf von `app.audit_hash` ergänzen.
- **Suche im Audit** `pgAuditSearch({ schema, subjectFallback? })(tx, { subject?, resourceType?, resourceId?, actor?,
  from, to, cursor?, limit?, order? })`: im Mandanten der Transaktion, Zeitraum `[from, to)` Pflicht, Seiten über
  `(ts, seq)` (Standard neueste zuerst, 1–200, Standard 50), Cursor nur für dieselben Filter; ungültige Eingaben → 422.
  Für Einträge ohne `subject_id` findet die Suche nach Person auch ein Feld in `data` (`subjectFallback.dataKeys`, z. B.
  `['personId']`) oder das Objekt (`subjectFallback.resourceTypes`). Typen `AuditQuery`, `AuditPage`, `AuditRecord`,
  `AuditSearch`, `AuditSubjectFallback`.
- **Lesen des Audits an ein Recht binden** (Wahl der App): `SELECT app.audit_read_permission('audit:read')` in einer
  Migration der App legt die Policy `audit_read` an (RESTRICTIVE, nur SELECT, `<produkt>_app`,
  `app.has_permission(p)`); lesen dann nur mit dem Recht an `org` oder voller Sicht. Anhängen bleibt ohne Recht
  möglich: `app.audit_chain()` liest den letzten Eintrag dann als Besitzer (SECURITY DEFINER). Die App führt
  `app.audit_chain()` deshalb unter `exceptions.securityDefiner` in `identity.app.json` (Konformitätstest) und in ihrem
  RLS-Test auf, dort auch die Policy. Das Recht muss im Modell stehen (sonst gilt es auch in der vollen Sicht nicht).
  `NULL` hebt die Bindung auf. Ohne Aufruf ändert sich nichts.

- **Grund, wenn keine E-Mail versendet wurde** (`EmailError`): `emailError` in der Antwort von «Person einladen» und
  «Aus Entra hinzufügen» (`mail-not-configured`: kein E-Mail-Versand im Realm, `mail-failed`: eingerichtet, aber
  gescheitert, z. B. Mailserver lehnt die Anmeldung ab; null, wenn versendet oder keine E-Mail verlangt). «Einladung
  erneut senden» antwortet bei 502 mit `reason` (gleiche Werte) und passendem `detail`. Der Grund sagt nur etwas über
  den Realm, nie über ein Konto (gleich für neue und bestehende Konten).
- **Scopes für die Anmeldung am MCP-Dienst wählbar** (`McpAuthOptions.scopes`): Die App legt fest, welche Scopes
  des Katalogs ein MCP-Host bei der Anmeldung anfordert (`scope` in `WWW-Authenticate`), z. B.
  `scopes: ['assets:read', 'objects:write']`; `openid` und `organization:*` kommen immer davor. Ohne Option wie
  bisher nur `<produkt>:read`. Hosts wie Claude fordern die Liste bei der nächsten Anmeldung an; wirksam bleibt
  Rolle ∩ Scope. Unbekannte Scopes oder eine leere Liste ergeben beim Start `ConfigError`.

### Geändert

- 502 von «Einladung erneut senden» rät nicht mehr immer «E-Mail-Versand im Realm einrichten»: Mit eingerichtetem
  Versand nennt `detail` den Mailserver und das Protokoll von Keycloak.

### Behoben

- OIDC-Discovery wiederholt einen Abruf, der mit einem Netzwerkfehler scheitert (z. B. `ECONNRESET`, wenn der
  Anmeldedienst eine Keep-alive-Verbindung gerade schliesst, als sie wiederverwendet wird), genau einmal sofort. Davor
  ergab schon ein einzelner abgebrochener Abruf 503 «Anmeldedienst nicht erreichbar» (beim ersten Request nach dem
  Start, nach Ablauf des Zwischenspeichers und in `/readyz`). Bleibt der Fehler, wie bisher 503; `detail` nennt neu
  den Code der Ursache (`Discovery fetch failed (ECONNRESET)`). Zeitüberschreitung und HTTP-Fehler werden nicht
  wiederholt, das Zeitlimit gilt für beide Versuche zusammen.

## [5.0.3] – 2026-10-28

### Behoben

- `Nullable(X)` in den Routen des Pakets machte mit `coerceTypes` aus **ungültigen** Eingaben `null` statt 400 (der
  Zweig `{ type: 'null' }` wandelt 0, `""` und `false`, wenn X sie ablehnt). Neu `anyOf [{ const: null }, X]` wie in
  `@vollholz/platform` 0.7.0. Betroffene Felder: `POST /v1/access` `id` und `secretExpiresAt` der Entra-Verbindung mit
  `""` → bisher null, jetzt 400 (iam-web schickt `null`); die Beschreibung der Organisation (`""` bleibt `""`) und
  alle anderen Eingaben unverändert. OpenAPI: der Zweig `{ type: "null" }` entfällt, erzeugte Typen bleiben `X | null`.

## [5.0.2] – 2026-10-28

### Behoben

- `Nullable` (seit 5.0.1) mit `Value.Check`, `Value.Errors` und dem TypeCompiler von TypeBox: Der Zweig `{ const: null }`
  hatte die Kind «Unsafe», TypeBox warf «Unknown type» (in einer App mit `Value.Check` auf ein Schema mit `Nullable`:
  500). Neu eigene Kind `NullExakt` in der TypeRegistry (prüft `=== null`); TypeBox liefert für jede Eingabe dasselbe
  Ergebnis wie AJV (ohne Umwandlung) und wie vor 5.0.1. OpenAPI unverändert. Voraussetzung: die App
  benutzt dieselbe Kopie von `@sinclair/typebox` wie dieses Paket (0.34.52; `npm ls @sinclair/typebox`), sonst kennt
  ihre TypeRegistry die Kind nicht.

## [5.0.1] – 2026-10-28

### Behoben

- `Nullable(X)` mit `coerceTypes` (Standard von Fastify, auch in `@vollholz/platform`): `anyOf [X, null]` machte aus
  `null` den Wert von X, wenn er dort gültig ist (0, `""`, `false`). Neu `anyOf [{ const: null }, X, { type: 'null' }]`
  wie in `@vollholz/platform` 0.6.2: `null` bleibt `null`, alle anderen Eingaben wie bisher. In den Routen des Pakets
  war der Fehler nicht sichtbar (Uuid und Datum lehnen `""` ab; die Beschreibung der Organisation wird mit `null` ohnehin
  geleert); betroffen waren eigene Routen der App mit `Nullable` aus diesem Paket.

### Geändert

- OpenAPI: Jedes `Nullable` hat vorne einen Zweig `{ "enum": [null] }` (aus `const: null`). Aus der Doku erzeugte
  Typen bleiben `X | null` (openapi-typescript).

## [5.0.0] – 2026-10-28

### Breaking

- **Eigene Rollen der Organisation sind Standard** (`features.customRoles`, Standard true mit `features.members`): Das
  Modell erhält das reservierte Recht **`roles:admin`** «Rollen zusammenstellen» (Gruppe `members`, nur Personen, ohne
  Rolle der App nur bei org-admin). Kataloge, `adminOnly` und Rechte von org-admin ändern sich dadurch.
  Migration: Tests der App, die Rechtelisten von org-admin, `adminOnly` oder den Katalog genau vergleichen, um
  `roles:admin` ergänzen – oder eigene Rollen mit `features: { customRoles: false }` in `defineModel` abschalten (dann
  ändert sich nichts ausser der Migration `iam_019`).
- **Migration `iam_019_custom_roles.sql`** (läuft mit dem nächsten `migrate`): Tabelle `<schema>.authz_role` (RLS ENABLE
  + FORCE, `tenant_isolation`, Policy `owner_tenant` für die Besitzer-Rolle), Trigger `authz_role_guard`,
  `authz_role_acl_version` und `authz_tuple_custom_role`.
  Migration: Prüfungen der App, die alle Tabellen bzw. Policies aufzählen (RLS-Matrix), um `authz_role` (Tabelle des
  Baukastens) und `authz_role.owner_tenant` ergänzen.
- **CHECK `authz_tuple_relation_check`** lässt mit eigenen Rollen zusätzlich Relationen `c-…` zu und trägt wie
  `authz_tuple_type_relation_check` eine Marke im Kommentar (`syncModelChecks` passt beide beim nächsten Lauf an).
  Migration: Tests, die die Definition des CHECKs mit `pg_get_constraintdef` vergleichen, auf die Relationen prüfen.
- **Neues Modul `roles`** mit den Routen `GET/POST /v1/admin/roles`, `PUT/DELETE /v1/admin/roles/{key}` und denselben unter
  `/v1/platform/organizations/{alias}/roles` (Standard geladen, wenn eigene Rollen an sind).
  Migration: im Isolations-Durchlauf der App (`coverageProblems`) aufnehmen oder ausnehmen; wer `modules` ausdrücklich
  angibt, ergänzt `'roles'`, um sie anzubieten.
- **Rollen des Modells mit Schlüssel `c-…`** sind ein Fehler im Modell (`ModelError`, der Präfix gehört eigenen Rollen).
  Migration: solche Rollen umbenennen (Tupel mit Migration nachführen).
- **`TenantAccess`** hat die Felder `model` (Modell der Organisation) und `roles` (eigene Rollen).
  Migration: nur Tests, die `TenantAccess` von Hand bauen: `model: <modell>, roles: []` ergänzen.

### Hinzugefügt

- **Rollen zur Laufzeit** (docs/authz-offene-punkte.md O17, PPM UC-016 A2): `model.withRoles(defs)` (Modell der
  Organisation), `model.customRoleProblems(def)`, `CUSTOM_ROLE_KEY`, `CUSTOM_ROLE_LIMIT` (50), Typ `CustomRoleDef`;
  `iam.roles` (`CustomRoles`: `list`, `get`, `create`, `update`, `remove`), `customRoleKey(label)`,
  `loadCustomRoles(tx, schema)`, `access.modelOf(tenantId)`, `access.modelIn(tx)`.
- Entscheidung, Lesesicht (RLS), «Wer hat Zugriff?», «Warum?», Rollen setzen, Einladen, Freigaben an Orten und Clients
  lösen eigene Rollen wie Rollen des Modells auf. `GET /v1/authz/catalog` liefert in einer Organisation ihre eigenen
  Rollen mit (`custom: true`, nach den Rollen des Modells, in `types[].roles` an ihren Orten); `GET /v1/admin/status`
  ebenso.
- Regeln: nur Rechte des Modells, keine nur von org-admin (422); niemand gibt mehr, als er hat (403 `exceeds-own`, beim
  Ändern vorher und nachher); Name eindeutig (409 `duplicate-label`); höchstens 50 (409 `limit`); löschen und Orte
  entfernen nur unvergeben (409 `in-use`, auch per Trigger in der Datenbank); Audit `role.created`, `role.updated`,
  `role.deleted` (`data.key`). Vergaben melden die Haken wie jede Rolle (`access.granted`, `access.revoked`).
- Gleichzeitiges Vergeben und Löschen bzw. Orte entfernen: Der Trigger `authz_tuple_custom_role` sperrt die Zeile der
  Rolle (`FOR SHARE`), das Löschen wartet und lehnt dann ab (`in-use`); ein Schlüssel, unter dem noch Vergaben ohne
  Rolle stehen, wird nicht neu vergeben (409 `in-use`). So erbt nie jemand ungeprüft die Rechte einer neuen Rolle.
- `checkRoles(…, model)`, `checkRoleChange(…, model)`, `TupleStore.check(t, model)`, `TupleStore.modelFor(tx, relation)`:
  optionales Modell der Organisation.

### Geändert

- Eigene Rollen wieder abschalten (`customRoles: false`, nachdem es schon Vergaben gab): zuerst alle Tupel mit
  Relation `c-…` löschen, sonst bricht `syncModelChecks` beim nächsten `migrate` ab (wie bei entfernten Rollen).
- Eine eigene Rolle überschreibt nie eine Rolle des Modells (Schlüssel immer `c-…`); ändert sich das Modell, fallen
  Rechte und Orte, die es nicht mehr gibt oder die nur org-admin hat, aus eigenen Rollen weg (nie mehr Rechte).

## [4.0.0] – 2026-10-28

### Breaking

- **`IamEvents` ist ein Objekt mit zwei Haken** statt einer Funktion: `events: { before?(tx, e), after?(tx, e) }` in
  `createIam` (bisher `(tx, type, subject, data) => Promise<void>`, vom Paket nie aufgerufen). Jedes Ereignis
  `e = { type, tenantId, subject, actor, data }`.
  Migration: Wer `events` übergab, schreibt `events: { after: async (tx, e) => alt(tx, e.type, e.subject, e.data) }`
  oder lässt die Option weg. Typen `IamEvent`, `IamEventMap`, `IamEventType`, `AccessEventData`, `MemberEventData`,
  `MemberLeftEventData` aus `@vollholz/iam`.
- **`after` erhält jetzt Ereignisse** (bisher keine): je Rolle an einem Ort `access.granted` (auch neuer Ablauf, mit
  `previousExpiresAt`), `access.revoked` und `access.expired`, auch für Rollen an `org` aus «Rollen setzen», Einladen,
  Clients und für Aufrufe der App über `iam.tuples` (ohne `actor`: `principal: null`, `source: 'system'`); dazu
  `member.removed` und `member.left`.
  Migration: Erzeugt die App `access.changed` selbst (offener Punkt O10), diese Stellen entfernen oder aus `after`
  bilden, sonst doppelt. Wer `after` an eine Outbox hängt, filtert nach `e.type`.
- **`TupleStore`-Methoden** nehmen `TupleActor` (`Actor` mit `extra` und `audit?: false`); `audit: false` meldet das
  Ereignis ohne Audit je Tupel. Aufrufe mit `actor` wie bisher bleiben gültig.
  Migration: nur wer `new TupleStore(…)` selbst baut und Ereignisse will, gibt `events` mit.

### Hinzugefügt

- **Haken beim Entfernen eines Mitglieds** (`AdminService.removeMember`, damit `DELETE /v1/admin/members/{id}`,
  `DELETE /v1/platform/organizations/{alias}/members/{id}`, «Benutzer und Rollen» in `@vollholz/iam-web` und Aufrufe der
  App über `iam.admin`): `before` mit `member.removing` nach den Prüfungen des Pakets, unter der Sperre der
  Organisation und vor jeder Änderung in Keycloak; wirft er, unterbleibt das Entfernen, ein `HttpError` (z. B.
  `conflict(detail, { reason })`) geht als application/problem+json mit allen Zusatzfeldern zurück. `after` mit
  `member.removed` (vorher je Tupel `access.revoked`) in derselben Transaktion; wirft er, wird zurückgerollt, die in
  Keycloak entfernte Mitgliedschaft bleibt und steht als `member.remove_failed` im Audit. Daten `MemberEventData`:
  `memberId`, `userId`, `principalId`, `email`, `roles`, `invitation`, `platform`. Gilt auch für das Zurückziehen
  einer Einladung (`invitation: true`).
- **Abgleich und Aufräumen melden** `member.left` (Austritt ausserhalb der App, Tupel bleiben) und `access.expired`:
  `MemberSync(…, { events })`, `SyncContext.events`.
- `setOrgRoles(…, { actor })`: wer handelt, für die Ereignisse (kein Audit je Tupel).
- `migrate(adminUrl, sources, { log, ssl })`: TLS nach `DATABASE_SSL` (`MigrateOptions`); die bisherige Form mit `log`
  als drittem Argument gilt weiter. `pgSsl(mode)`, `dbSslFromEnv(env)`, `DB_SSL_MODES`, Typ `DbSsl`.
- `orgBootstrap`/`orgBootstrapFile` (`database.ssl`) und `resetDatabase` (`ssl`) mit TLS.

### Behoben

- `migrate` öffnete `pg.Client` nur mit der Adresse: Eine Datenbank, die nur `hostssl` zulässt, lehnte ab. Jetzt TLS
  wie die übrigen Verbindungen; ein `sslmode` in der Adresse hat weiterhin Vorrang.
- `iam-org-bootstrap` und `iam-reset` halten `DATABASE_SSL` ein (bisher ohne TLS). Hinweis: Mit `verify-full` muss das
  Zertifikat der Datenbank prüfbar sein (wie für API und Worker).
- Beschreibung von `DELETE …/members/{id}` in der OpenAPI nennt die mögliche Ablehnung durch die App.

## [3.2.1] – 2026-10-27

Stand bis 3.2.1, ohne Einzelnachweis. Frühere Versionen: Tags `iam-v*` und Hinweise im README des Pakets und in docs/ausrollen.md.
