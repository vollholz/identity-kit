/**
 * Kontext einer App auf der Plattform: technischer Name, Schema, Titel und Präfix der Ereignisse. Alle Bausteine des
 * Pakets erhalten ihn statt fest eingebauter Namen; `definePlatform` (platform.ts) baut ihn einmal je App.
 */
import { checkProduct, productIdent } from '@vollholz/iam';

export interface PlatformContext {
  /** Technischer Name wie in der Konfiguration (`nachtschicht`, `my-app`). */
  readonly product: string;
  /** Schema der Tabellen (Standard `productIdent(product)`). */
  readonly schema: string;
  /** Datenbankrollen `<ident>_app` und `<ident>_sched`. */
  readonly roles: { readonly owner: string; readonly app: string; readonly sched: string };
  /** Anzeigename (OpenAPI, Hinweisseite, MCP-Server). */
  readonly title: string;
  /** Präfix des CloudEvents-Typs (Standard `ch.<product>`), z. B. `ch.nachtschicht.schichtart.created`. */
  readonly eventPrefix: string;
}

export interface ContextSpec {
  product: string;
  schema?: string;
  title: string;
  eventPrefix?: string;
}

const IDENT = /^[a-z][a-z0-9_]{0,62}$/;

export function platformContext(s: ContextSpec): PlatformContext {
  const product = checkProduct(s.product);
  const ident = productIdent(product);
  const schema = s.schema ?? ident;
  if (!IDENT.test(schema)) throw new Error(`schema: ungültiger Bezeichner «${schema}»`);
  const eventPrefix = s.eventPrefix ?? `ch.${ident.replace(/_/g, '-')}`;
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(eventPrefix)) throw new Error(`eventPrefix: ungültig «${eventPrefix}»`);
  return Object.freeze({
    product, schema, title: s.title, eventPrefix,
    roles: Object.freeze({ owner: `${ident}_owner`, app: `${ident}_app`, sched: `${ident}_sched` }),
  });
}
