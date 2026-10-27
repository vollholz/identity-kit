# Playbook: App auf einem neuen Hetzner-Projekt einrichten

Für die erste Inbetriebnahme einer App des Baukastens in einem **eigenen Hetzner-Projekt** (App-VM und DB-VM im privaten
Netz, Domain unter `project-suite.ch`, Anmeldung über `https://identity.project-suite.ch`). Entstanden bei der ersten
Einrichtung von nachtschicht (Oktober 2026). Die Befehle stehen im Repository der App (`deploy/hetzner/README.md`); hier
stehen Reihenfolge, wer was tut, die Entscheide mit ihren Standardwerten und die Stolpersteine.

`<produkt>` ist der technische Name der App (wie in [neue-app.md](neue-app.md)), `<PRODUKT>` derselbe in Grossbuchstaben.

## Wer tut was

| Rolle | Aufgaben |
|---|---|
| **Person** (Inhaber:in von Hetzner, GitHub, Infomaniak) | Konten und Tokens anlegen, Werte in die Session-Umgebung und in GitHub eintragen, Freigaben in den Workflows, Passwortmanager |
| **Claude-Session** (Cloud) | alles über API und CLI: Buckets, OpenTofu, SOPS, Schlüssel, DB-VM, DNS, Pull Requests, Rollout, Rauchtest |

Die Session kann **keine GitHub-Secrets lesen oder setzen** und sieht **keine Org-Secrets**. Was in GitHub gehört, legt
sie als Datei ab; die Person überträgt die Werte und löscht die Datei.

## 0. Vorab entscheiden

| Frage | Standard | Begründung |
|---|---|---|
| Domain | `<produkt>.project-suite.ch` | Zone `project-suite.ch` liegt bei **Infomaniak** (DNS-API, Token `INFOMANIAK_API_TOKEN`); Einträge A, AAAA, CAA setzt die Session |
| Keycloak | `https://identity.project-suite.ch`, ohne Basispfad | Instanz aus `vollholz/identity`; `identity.app.json` › `keycloakUrl`, `OIDC_ISSUER_URL` = `…/realms/<produkt>` |
| Standort | `nbg1` | Standard in `infra/hetzner`; Buckets am selben Standort |
| S3-Schlüssel | **einer** für State und pgBackRest | S3-Zugangsdaten gelten bei Hetzner für alle Buckets des Projekts; zwei trennen nur die Verwaltung (einzeln ersetzen), nicht die Rechte |
| SSH auf die App-VM | `0.0.0.0/0`, `::/0`, nur Schlüssel | GitHub-Runner haben keine festen Adressen; Passwort- und root-Login aus, DB-VM ohne öffentliches SSH. Deploy-Schlüssel mit erzwungenem Befehl einschränken (Vorbild `vollholz/identity`, `deploy/host/identity-ssh-gate.sh`) |
| age-Schlüssel des Betriebs | **lokal** erzeugen, nur `age1…` an die Session | der private Teil verlässt den Rechner nie; den Deploy-Schlüssel (für `SOPS_AGE_KEY`) erzeugt die Session |
| Erste Organisation | Alias, Name, E-Mail der Admin-Person | `organizations` im Manifest ([neue-app.md › 10](neue-app.md#10-betrieb-erste-organisation-und-microsoft-entra-id)) |
| Konto des Betriebs | eigene E-Mail, nie dieselbe wie die Admin-Person | `operators` im Manifest |

## 1. Vorbereiten (Person, vor der Session)

1. **Hetzner-Projekt** `<produkt>` anlegen; *Sicherheit › API-Tokens*: Token mit Lesen & Schreiben.
2. **Object Storage**: *Object Storage › Bucket erstellen*, `<produkt>-tofu-state`, privat, `nbg1` (der erste Bucket
   schaltet Object Storage ein). *Sicherheit › S3-Zugangsdaten › Zugangsdaten generieren*: Der Secret Key erscheint
   **nur einmal**, sofort in den Passwortmanager.
3. **Infomaniak**: Den Token (`dns:read`, `dns:write`) gibt es schon als Org-Secret `INFOMANIAK_API_TOKEN` in
   `vollholz` (Zugriff «Selected repositories»): das neue Repository dort hinzufügen.
4. **age-Schlüssel** des Betriebs (Windows, PowerShell):

   ```powershell
   winget install FiloSottile.age          # danach PowerShell neu öffnen
   mkdir $env:APPDATA\sops\age -Force
   age-keygen -o $env:APPDATA\sops\age\keys.txt
   ```

   macOS/Linux: `age-keygen -o ~/.config/sops/age/keys.txt`. `keys.txt` in den Passwortmanager; die Zeile
   `Public key: age1…` bekommt die Session.
5. **Session-Umgebung** (Umgebungsmenü im Titel der Session › *Edit*): Werte je Projekt mit Präfix, damit sie nicht mit
   den Werten anderer Projekte derselben Umgebung kollidieren:

   | Variable | Inhalt |
   |---|---|
   | `<PRODUKT>_HCLOUD_TOKEN` | Hetzner-Token aus 1 |
   | `<PRODUKT>_S3_ACCESS_KEY`, `<PRODUKT>_S3_SECRET_KEY` | S3-Zugangsdaten aus 2 |
   | `INFOMANIAK_API_TOKEN` | Infomaniak-Token (für alle Apps derselbe) |

   Die Session reicht sie unter den Namen weiter, die die Skripte lesen (`HCLOUD_TOKEN`, `S3_ACCESS_KEY`, …).
6. **Neue Session starten.** Umgebungsvariablen gelten erst ab dem Start einer Session.

## 2. Auftrag an die Session

> Richte `<produkt>` auf dem Hetzner-Projekt ein nach `deploy/hetzner/README.md` und `identity-kit/docs/hetzner-einrichten.md`.
> Keycloak `identity.project-suite.ch`, DNS bei Infomaniak, ein S3-Schlüssel für State und pgBackRest, Hetzner-Token in
> `<PRODUKT>_HCLOUD_TOKEN`. Mein age-Schlüssel: `age1…`. Erste Organisation: `<alias>` «<Name>», Admin `<e-mail>`;
> Betrieb `<e-mail>`. Keycloak-Client-Schlüssel in der Session erzeugen und sofort in SOPS verschlüsseln.

## 3. Ablauf in der Session

| # | Schritt | Freigabe durch die Person |
|---|---|---|
| 1 | Zugänge prüfen: Hetzner-API (keine Server), Infomaniak-Zone `project-suite.ch`, Buckets | – |
| 2 | Bucket `<produkt>-pgbackrest` anlegen, State-Passphrase erzeugen | – |
| 3 | `.sops.yaml` mit `age1…` der Person und dem Deploy-Schlüssel; `deploy/hetzner/secrets.sops.yaml` füllen und verschlüsseln | PR |
| 4 | Keycloak-Client-Schlüssel (`npx create-iam-app keys`): öffentliche nach `infra/keycloak/keys/`, private **sofort** in die SOPS-Datei bzw. in die Übergabedatei (`<produkt>-iac`, `<produkt>-tofu`) | PR |
| 5 | Server mit OpenTofu (`infra/hetzner`, `tofu plan`/`apply`) | Plan ansehen |
| 6 | DB-VM einrichten (`deploy/hetzner/db/setup.sh`), CA in die SOPS-Datei | – |
| 7 | DNS bei Infomaniak: A, AAAA, CAA für `<produkt>` | – |
| 8 | Übergabedatei: Werte für GitHub und Passwortmanager (Abschnitt 4) | Person überträgt |
| 9 | `<produkt>-tofu.json` an den Betreiber (PR in `vollholz/identity`), Realm über Workflow «Keycloak» | PR, «Approve» |
| 10 | Erster Rollout: Workflow «Deploy» › `deploy` mit dem Digest aus CI auf `main` | «Approve» |
| 11 | Erste Organisation und Betrieb (`npm run identity:first-org`), Rauchtest (`npm run smoke`) | – |
| 12 | PITR einmal auf einer Wegwerf-VM üben, Ergebnis in `docs/betrieb.md` | – |

## 4. Übergabe an die Person

**GitHub**, Repository der App, *Settings › Environments › production*:

| Secrets | Variablen |
|---|---|
| `HCLOUD_TOKEN`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `TF_STATE_PASSPHRASE`, `SOPS_AGE_KEY`, `DEPLOY_SSH_KEY`, `KEYCLOAK_IAC_PRIVATE_KEY` | `APP_HOST`, `DEPLOY_KNOWN_HOSTS`, `ACME_EMAIL`, `HETZNER_BACKEND_HCL`, `HETZNER_TFVARS` |

**Passwortmanager**: age-Schlüssel des Betriebs, State-Passphrase, S3-Zugangsdaten, privater Schlüssel
`<produkt>-tofu`. Danach die Übergabedatei löschen.

## Stolpersteine

| Beobachtung | Ursache | Vorgehen |
|---|---|---|
| Variable in der Session leer, obwohl eingetragen | Umgebung gilt erst ab Session-Start | neue Session starten |
| Session sieht ein Org- oder Repo-Secret nicht | Secrets sind nur für Workflows lesbar, für niemanden sonst | Wert zusätzlich in die Session-Umgebung; Originale im Passwortmanager |
| Secret aus Repository A in Repository B gebraucht | Repo-Secrets gelten nur im eigenen Repository | Org-Secret mit «Selected repositories»; Environment geht vor Repo, Repo vor Org |
| Private Schlüssel nach Sessionende weg | im flüchtigen Container erzeugt, nirgends gesichert (nachtschicht OP-26) | in derselben Session in SOPS verschlüsseln oder an die Person übergeben, nie nur im Container |
| `npm login` bei GitHub Packages: 403 | Passwort statt Token, fine-grained Token oder SSO nicht freigegeben | Token (classic) `read:packages`; `npm config set //npm.pkg.github.com/:_authToken <token>` |
| `create-iam-app keys` unter Windows bricht ab («für andere zugänglich») | prüft Unix-Dateirechte des Schlüsselverzeichnisses | WSL nutzen oder Schlüssel in der Session erzeugen (Schritt 4) |
| Codex-Review «A repository needed for this review could not be found» | Codex fehlt der Zugriff auf ein Repository | nicht am PR; Zugriff in Codex geben, `@codex review` |
| Doku nennt Hostpoint oder `id.project-suite.ch` | veraltet | Zone bei Infomaniak, Keycloak `identity.project-suite.ch`; Doku der App nachführen |
