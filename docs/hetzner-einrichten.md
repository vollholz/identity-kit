# Playbook: App auf einem neuen Hetzner-Projekt einrichten

Für die erste Inbetriebnahme einer App des Baukastens in einem **eigenen Hetzner-Projekt** (App-VM und DB-VM im privaten
Netz, Domain unter `project-suite.ch`, Anmeldung über `https://identity.project-suite.ch`). Entstanden bei der ersten
Einrichtung von nachtschicht (Oktober 2026). Die Befehle stehen im Repository der App (`deploy/hetzner/README.md`); hier
stehen Reihenfolge, wer was tut, die Entscheide mit ihren Standardwerten und die Stolpersteine.

`<produkt>` ist der technische Name der App (wie in [neue-app.md](neue-app.md)), `<PRODUKT>` derselbe in Grossbuchstaben.

## Wer tut was

| Rolle | Kann | Kann nicht |
|---|---|---|
| **Person** (Inhaber:in von Hetzner, GitHub, Infomaniak) | Konten, Tokens und Limits, GitHub-Secrets (`gh secret set`), Freigaben in Workflows, Merge, Passwortmanager | – |
| **Cloud-Session** (claude.ai/code) | HTTPS-APIs: Hetzner, Object Storage (S3), Infomaniak, OpenTofu, SOPS, Schlüssel erzeugen, Pull Requests, Workflows starten und auswerten | **kein SSH** (nur HTTPS über einen Proxy), keine GitHub-Secrets lesen oder setzen, keine Org-Secrets sehen |
| **Lokale Session** (Claude Code auf dem Rechner der Person) | alles mit SSH: DB-VM einrichten, Host-Schlüssel holen, Gate prüfen, Rollout von Hand; `gh` mit den Rechten der Person | – |
| **Workflows** (GitHub Actions) | Infrastruktur (`infra.yml`), Realm (`keycloak.yml`), Deploy über das Gate (`deploy.yml`) | erst, wenn die Secrets gesetzt sind |

Die Cloud-Session legt alles, was die Person oder eine lokale Session braucht, **verschlüsselt** ins Repository
(`infra/hetzner/betrieb.sops.yaml`, nur Empfänger «Betrieb»), nie als Klartextdatei.

## 0. Vorab entscheiden

| Frage | Standard | Begründung |
|---|---|---|
| Domain | `<produkt>.project-suite.ch` | Zone `project-suite.ch` liegt bei **Infomaniak** (DNS-API, Token `INFOMANIAK_API_TOKEN`); Einträge A, AAAA, CAA setzt die Cloud-Session |
| Keycloak | `https://identity.project-suite.ch`, ohne Basispfad | Instanz aus `vollholz/identity`; `identity.app.json` › `keycloakUrl`, `OIDC_ISSUER_URL` = `…/realms/<produkt>` |
| Standort, Servertyp | `nbg1`, `cx33` (4 vCPU, 8 GB) für App und DB | `cx32` gibt es nicht mehr; aktuelle Typen: `GET /v1/server_types` |
| S3-Schlüssel | **einer** für State (Hetzner und Realm) und pgBackRest | S3-Zugangsdaten gelten bei Hetzner für alle Buckets des Projekts; zwei trennen nur die Verwaltung, nicht die Rechte |
| SSH auf die App-VM | `0.0.0.0/0`, `::/0`, nur Schlüssel | GitHub-Runner haben keine festen Adressen. Benutzer `betrieb` für Personen (Sprungserver zur DB-VM), root ohne SSH; Benutzer `deploy` nur mit erzwungenem Befehl (`deploy/hetzner/<produkt>-ssh-gate.sh`, Vorbild `vollholz/identity` › `deploy/host/identity-ssh-gate.sh`): keine Shell, keine Weiterleitungen, nicht in der Gruppe `docker` |
| age-Schlüssel des Betriebs | **lokal** erzeugen, nur `age1…` an die Session | der private Teil verlässt den Rechner nie; den Deploy-Schlüssel (`SOPS_AGE_KEY`) erzeugt die Session |
| Image | privat auf `ghcr.io` | Workflow «Deploy» und VM brauchen dann eine Anmeldung bei ghcr.io (siehe Stolpersteine); sonst Package öffentlich |
| Erste Organisation | Alias, Name, E-Mail der Admin-Person | `organizations` im Manifest ([neue-app.md › 10](neue-app.md#10-betrieb-erste-organisation-und-microsoft-entra-id)) |
| Konto des Betriebs | eigene E-Mail, nie dieselbe wie die Admin-Person | `operators` im Manifest |

## 1. Vorbereiten (Person, vor der Session)

1. **Hetzner-Projekt** `<produkt>` anlegen; *Sicherheit › API-Tokens*: Token mit Lesen & Schreiben.
2. **Limits prüfen** (*Konto › Limits*): Neue Konten haben tiefe Limits, und sie gelten für das **ganze Konto**, nicht je
   Projekt. Für zwei `cx33`: mindestens **4 Primary IPs** (je VM IPv4 und IPv6) und **8 freie Shared vCPUs** zusätzlich
   zu den Servern der anderen Projekte. «Dedicated vCPUs» betrifft nur `ccx`. Erhöhung vor der Session anfragen.
3. **Object Storage**: *Object Storage › Bucket erstellen*, `<produkt>-tofu-state`, privat, `nbg1` (der erste Bucket
   schaltet Object Storage ein). *Sicherheit › S3-Zugangsdaten › Zugangsdaten generieren*: Der Secret Key erscheint
   **nur einmal**, sofort in den Passwortmanager.
4. **Infomaniak**: Token mit `dns:read` und `dns:write` (für alle Apps derselbe).
5. **Werkzeuge lokal**: `age`, `sops`, `gh` (angemeldet), Git, Claude Code. Unter Windows (PowerShell):

   ```powershell
   winget install FiloSottile.age GitHub.cli
   # sops hat kein winget-Paket: Programmdatei aus den Releases
   New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Programs\sops" | Out-Null
   Invoke-WebRequest "https://github.com/getsops/sops/releases/download/v3.11.0/sops-v3.11.0.amd64.exe" -OutFile "$env:LOCALAPPDATA\Programs\sops\sops.exe"
   [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:LOCALAPPDATA\Programs\sops", "User")
   ```

   Danach PowerShell neu öffnen.
6. **age-Schlüssel** des Betriebs:

   ```powershell
   New-Item -ItemType Directory -Force "$env:APPDATA\sops\age" | Out-Null      # Windows: SOPS sucht hier
   age-keygen -o "$env:APPDATA\sops\age\keys.txt"
   ```

   Linux: `~/.config/sops/age/keys.txt`; macOS: `~/Library/Application Support/sops/age/keys.txt` (oder
   `SOPS_AGE_KEY_FILE` setzen). Inhalt in den Passwortmanager; die Zeile `public key: age1…` bekommt die Session.
7. **Session-Umgebung** (Umgebungsmenü im Titel der Session › *Edit*): Werte je Projekt mit Präfix, damit sie nicht mit
   den Werten anderer Projekte derselben Umgebung kollidieren:

   | Variable | Inhalt |
   |---|---|
   | `<PRODUKT>_HCLOUD_TOKEN` | Hetzner-Token aus 1 |
   | `S3_ACCESS_KEY`, `S3_SECRET_KEY` (oder mit Präfix) | S3-Zugangsdaten aus 3 |
   | `INFOMANIAK_API_TOKEN` | Infomaniak-Token aus 4 |

   Die Session reicht sie unter den Namen weiter, die die Werkzeuge lesen (`HCLOUD_TOKEN`, `AWS_ACCESS_KEY_ID`, …).
8. **Neue Session starten.** Umgebungsvariablen gelten erst ab dem Start einer Session.

## 2. Auftrag an die Cloud-Session

> Richte `<produkt>` auf dem Hetzner-Projekt ein nach `deploy/hetzner/README.md` und `identity-kit/docs/hetzner-einrichten.md`.
> Keycloak `identity.project-suite.ch`, DNS bei Infomaniak, ein S3-Schlüssel für alles, Hetzner-Token in
> `<PRODUKT>_HCLOUD_TOKEN`. Mein age-Schlüssel: `age1…`. Erste Organisation: `<alias>` «<Name>», Admin `<e-mail>`;
> Betrieb `<e-mail>`. Keycloak-Client-Schlüssel in der Session erzeugen und sofort in SOPS verschlüsseln. Deploy-Schlüssel
> mit erzwungenem Befehl einschränken.

## 3. Ablauf

| # | Schritt | Wer | Freigabe |
|---|---|---|---|
| 1 | Zugänge prüfen: Hetzner-API (noch keine Server), Infomaniak-Zone, Buckets | Cloud | – |
| 2 | Bucket `<produkt>-pgbackrest` anlegen, State-Passphrase erzeugen | Cloud | – |
| 3 | Schlüssel erzeugen: SSH `betrieb` und `deploy`, age-Schlüssel des Deploy-Workflows, Keycloak-Clients (`npx create-iam-app keys`); öffentliche nach `infra/keycloak/keys/` | Cloud | – |
| 4 | SOPS: `.sops.yaml` mit `age1…` der Person und des Deploy-Workflows; `deploy/hetzner/secrets.sops.yaml` (App, DB) und `infra/hetzner/betrieb.sops.yaml` (Werte der GitHub-Secrets, SSH-Schlüssel, `<produkt>-tofu`) **sofort** verschlüsseln; Klartext löschen | Cloud | – |
| 5 | Server mit OpenTofu (`infra/hetzner`); danach `tofu plan` muss «No changes» zeigen | Cloud | Plan ansehen |
| 6 | DNS bei Infomaniak: A, AAAA, CAA für `<produkt>` | Cloud | – |
| 7 | PR mit allem Obigen (Gate, SOPS, `identity.app.json` mit `organizations`, `operators`, `state`) | Cloud | Merge |
| 8 | GitHub-Environment `production` füllen (Abschnitt 4) | Person oder lokale Session | – |
| 9 | DB-VM einrichten (`deploy/hetzner/db/setup.sh` über `betrieb@<app>`), CA in `secrets.sops.yaml`, Push auf den PR | lokale Session | – |
| 10 | `DEPLOY_KNOWN_HOSTS` holen, Gate mit dem Deploy-Schlüssel prüfen (nur erlaubte Befehle) | lokale Session | – |
| 11 | PR in `vollholz/identity`: `infra/keycloak/keys/<produkt>-tofu.json` und `products` mit `grant_realm_admin = false` | Cloud | `kid` über zweiten Kanal bestätigen, Merge (Workflow «Keycloak» läuft danach von selbst) |
| 12 | Realm-Bootstrap mit `<produkt>-tofu` (privater Schlüssel nur lokal), danach zweiter PR in `vollholz/identity` mit `grant_realm_admin = true` | lokale Session, Cloud | Merge |
| 13 | Erster Rollout: Workflow «Deploy» › `deploy` mit dem Digest aus CI auf `main` (Zusammenfassung des Jobs «Image») | Cloud startet | «Approve» |
| 14 | Erste Organisation und Betrieb (`npm run identity:first-org`), Rauchtest (`npm run smoke`) | lokale Session | – |
| 15 | PITR einmal auf einer Wegwerf-VM üben, Ergebnis in `docs/betrieb.md` | lokale Session | – |

Cloud- und lokale Session arbeiten nacheinander am selben Branch: immer zuerst `git pull`, nie gleichzeitig pushen.

## 4. GitHub-Environment `production`

Die Werte stehen verschlüsselt in `infra/hetzner/betrieb.sops.yaml` (Abschnitt `github`). Die Person setzt sie mit
ihrem age-Schlüssel, ohne etwas abzutippen (PowerShell, im Repository der App):

```powershell
$r = "--env", "production", "--repo", "vollholz/<produkt>"
foreach ($n in "HCLOUD_TOKEN","S3_ACCESS_KEY","S3_SECRET_KEY","TF_STATE_PASSPHRASE","SOPS_AGE_KEY","DEPLOY_SSH_KEY","KEYCLOAK_IAC_PRIVATE_KEY") {
  sops -d --extract "[`"github`"][`"$n`"]" infra/hetzner/betrieb.sops.yaml | gh secret set $n @r
}
gh variable set APP_HOST @r --body "deploy@<produkt>.project-suite.ch"
gh variable set ACME_EMAIL @r --body "<e-mail des Betriebs>"
```

| Secrets | Variablen |
|---|---|
| `HCLOUD_TOKEN`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `TF_STATE_PASSPHRASE`, `SOPS_AGE_KEY`, `DEPLOY_SSH_KEY`, `KEYCLOAK_IAC_PRIVATE_KEY` | `APP_HOST`, `ACME_EMAIL`, `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan` auf den Namen aus `APP_HOST`, nicht die IP), `HETZNER_BACKEND_HCL`, `HETZNER_TFVARS` |

`HETZNER_TFVARS` muss **genau** den Werten der ersten Anlage entsprechen: Schlüsselname in `ssh_keys` (z. B. `betrieb`)
und der Kommentar am Ende des öffentlichen Schlüssels. Weicht er ab, ersetzt OpenTofu `hcloud_ssh_key` und damit die
Server. Im Zweifel den Namen aus dem State lesen (`tofu state list`).

**Passwortmanager**: age-Schlüssel des Betriebs, State-Passphrase, S3-Zugangsdaten. Alles andere steht verschlüsselt in
`betrieb.sops.yaml`.

## Stolpersteine

| Beobachtung | Ursache | Vorgehen |
|---|---|---|
| `Primary IP limit exceeded`, obwohl im Projekt keine IP existiert | Limit des Kontos (neue Konten: tief) | Primary IPs auf mindestens 4 erhöhen lassen |
| `shared core limit exceeded`, obwohl das Limit höher scheint | Shared vCPUs gelten für das ganze Konto; andere Projekte belegen sie; «Dedicated» betrifft nur `ccx` | Shared vCPUs um mindestens 8 über dem heutigen Verbrauch erhöhen |
| `server type cx32 not found` | Typ abgekündigt | `cx33`; Liste über `GET /v1/server_types` |
| PostgreSQL auf der Systemplatte statt auf dem Volume | OpenTofu hängt das Volume erst nach dem Server an; cloud-init sucht es zu früh | cloud-init wartet auf `/dev/disk/by-id/scsi-0HC_Volume_<id>` und hängt selbst ein (nachtschicht `cloud-init/db.yaml.tftpl`) |
| SSH aus der Cloud-Session bricht ab | Session hat nur HTTPS über einen Proxy | Schritte mit SSH in einer lokalen Session oder über einen Workflow |
| Variable in der Session leer, obwohl eingetragen | Umgebung gilt erst ab Session-Start | neue Session starten |
| Session sieht ein Org- oder Repo-Secret nicht | Secrets sind nur für Workflows lesbar | Wert zusätzlich in die Session-Umgebung; Originale im Passwortmanager |
| Private Schlüssel nach Sessionende weg | im flüchtigen Container erzeugt, nirgends gesichert (nachtschicht OP-26) | in derselben Session in SOPS verschlüsseln, nie nur im Container |
| `sops`: «no identity matched any of the recipients» | `keys.txt` am falschen Ort oder unvollständig | Windows `%APPDATA%\sops\age\keys.txt`, Zeile `AGE-SECRET-KEY-1…` muss drin sein; Dateiname nicht `keys.txt.txt` |
| `winget install Mozilla.SOPS`: kein Paket gefunden | kein winget-Paket | Programmdatei aus den Releases (Abschnitt 1) |
| `ssh` unter Windows lehnt den Schlüssel ab («unprotected private key») | Dateirechte zu offen | `icacls <datei> /inheritance:r /grant:r "$($env:USERNAME):(R)"` |
| `ssh -J` unter Windows findet den Schlüssel für den Sprungserver nicht | `-J` reicht `-i` nicht weiter | `-o "ProxyCommand=ssh -i <datei> -W %h:%p betrieb@<app>"` |
| `setup.sh`: postgres kann `bootstrap.sql` nicht lesen | Datei liegt unter `/root` | `psql … < bootstrap.sql` (root liest, postgres bekommt stdin) |
| Deploy: `cosign verify` mit `UNAUTHORIZED` | Image auf ghcr.io privat, Workflow nicht angemeldet; die VM hätte beim `docker pull` dasselbe Problem | Anmeldung mit dem kurzlebigen `GITHUB_TOKEN` im Workflow und eine Gate-Aktion `registry-login` (Vorbild `vollholz/assets` › `assets-ssh-gate.sh`), oder Package öffentlich |
| shellcheck in CI meldet, was lokal grün war | andere shellcheck-Version | Version wie in CI verwenden; `A && B \|\| C` als `if` schreiben (SC2015) |
| `create-iam-app keys` unter Windows bricht ab («für andere zugänglich») | prüft Unix-Dateirechte des Schlüsselverzeichnisses | Schlüssel in der Cloud-Session erzeugen (Schritt 3) oder WSL |
| `npm login` bei GitHub Packages: 403 | Passwort statt Token, fine-grained Token oder SSO nicht freigegeben | Token (classic) `read:packages`; `npm config set //npm.pkg.github.com/:_authToken <token>` |
| Codex-Review «usage limits» oder «repository could not be found» | Kontingent erschöpft bzw. fehlender Zugriff | nicht am PR; später `@codex review` |
| Doku nennt Hostpoint oder `id.project-suite.ch` | veraltet | Zone bei Infomaniak, Keycloak `identity.project-suite.ch`; Doku der App nachführen |
