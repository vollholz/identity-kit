/**
 * Werkzeuge des MCP-Dienstes: nur über die REST-API (keine zweite Fachlogik, keine Datenbank). Name, Titel, Recht
 * und `readOnly` stehen im Modell (`mcpTools`); das Modul liefert Beschreibung, Eingaben und Aufruf. Die API prüft die
 * Rechte ohnehin; der Dienst bietet ein Werkzeug nur an, wenn das Recht in mindestens einer Organisation gilt.
 */
import type { McpOrg } from '@vollholz/iam';
import { z } from 'zod';

export interface ToolDef {
  description: string;
  input: z.ZodRawShape;
  call(org: McpOrg, args: Record<string, any>): Promise<unknown>;
}

/** Eingabe `organisation` für jedes Werkzeug (Alias, nur nötig bei mehreren Organisationen). */
export const organisationArg = z.string().min(1).max(64).optional().describe('Alias der Organisation (nur nötig, wenn du mehreren angehörst).');
