-- Einmalige Einrichtung der Datenbank-Rollen einer App (Spezifikation Kap. 10.1; aus Assets db/bootstrap.sql).
-- Als Superuser bzw. Datenbank-Admin ausführen. Idempotent. Name und Passwörter über psql-Variablen:
--   psql "$SUPERUSER_URL" -v p=<produkt> -v db=<produkt> -v owner_pw=... -v runtime_pw=... -v worker_pw=... \
--     -f node_modules/@vollholz/iam/db/bootstrap.sql
--
-- Rollenmodell:
--   <p>_owner    besitzt alle Objekte, führt Migrationen aus. Keine Laufzeitnutzung.
--   <p>_app      Gruppenrolle der Laufzeit: Zugriff nur über RLS je Mandant (NOBYPASSRLS).
--   <p>_sched    Gruppenrolle für Warteschlange/Outbox über alle Mandanten (nur diese Tabellen).
--   <p>_runtime  Login der API und des MCP-Dienstes (Mitglied von <p>_app).
--   <p>_worker   Login des Workers (Mitglied von <p>_app und <p>_sched).

\set ON_ERROR_STOP on

SELECT 1 / (:'p' ~ '^[a-z][a-z0-9_]{0,40}$')::int AS produkt_gueltig \gset

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEROLE NOBYPASSRLS', :'p' || '_owner', :'owner_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'p' || '_owner') \gexec
SELECT format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', :'p' || '_app') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'p' || '_app') \gexec
SELECT format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', :'p' || '_sched') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'p' || '_sched') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOBYPASSRLS IN ROLE %I', :'p' || '_runtime', :'runtime_pw', :'p' || '_app')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'p' || '_runtime') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOBYPASSRLS IN ROLE %I, %I', :'p' || '_worker', :'worker_pw', :'p' || '_app', :'p' || '_sched')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'p' || '_worker') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'p' || '_owner') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', :'db', :'p' || '_app', :'p' || '_sched') \gexec
