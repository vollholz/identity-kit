-- iam_009 Eigene Rollen: Primärschlüssel (tenant_id, id) wie alle Mandantentabellen (Spezifikation Kap. 10.3).
-- Assets hatte (id) allein (Migration 049); eine ID aus einem anderen Mandanten verhält sich so auch bei künftigen
-- zusammengesetzten Fremdschlüsseln wie eine unbekannte. Keine Tabelle verweist auf tenant_role.

ALTER TABLE {{schema}}.tenant_role DROP CONSTRAINT tenant_role_pkey;
ALTER TABLE {{schema}}.tenant_role ADD CONSTRAINT tenant_role_pkey PRIMARY KEY (tenant_id, id);
