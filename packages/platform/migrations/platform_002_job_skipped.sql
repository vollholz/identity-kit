-- @vollholz/platform 002: Aufträge eines inaktiven Produktmoduls (Konzept «Module je Organisation», Abschnitt 6).
-- Der Worker beendet sie mit Status `skipped` und dem Grund in `result` (z. B. {"modul": "inaktiv"}) – kein Fehler, kein
-- neuer Versuch; die Aufbewahrung löscht sie wie erledigte Aufträge.
ALTER TABLE {{schema}}.job DROP CONSTRAINT job_status_check;
ALTER TABLE {{schema}}.job ADD CONSTRAINT job_status_check CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped'));
ALTER TABLE {{schema}}.job ADD COLUMN result jsonb;
