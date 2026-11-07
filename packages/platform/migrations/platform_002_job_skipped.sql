-- @vollholz/platform 002: Aufträge eines inaktiven Produktmoduls (Konzept «Module je Organisation», Abschnitt 6).
-- Der Worker beendet sie mit Status `skipped` und dem Grund in `result` (z. B. {"modul": "inaktiv"}) – kein Fehler, kein
-- neuer Versuch; die Aufbewahrung löscht sie wie erledigte Aufträge.
-- Übernommene Schemas (`migrations.adopted`) können die Prüfung des Status unter anderem Namen haben: jede CHECK-Bedingung
-- auf `job`, die nur die Spalte `status` betrifft, wird ersetzt.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = '{{schema}}.job'::regclass AND con.contype = 'c'
       AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = '{{schema}}.job'::regclass AND attname = 'status')]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE {{schema}}.job DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE {{schema}}.job ADD CONSTRAINT job_status_check CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped'));
ALTER TABLE {{schema}}.job ADD COLUMN result jsonb;
