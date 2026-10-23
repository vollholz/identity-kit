/**
 * Abhängigkeiten des IAM einmal gebaut (Entwurf 3.1, 3.2; in Assets `Deps` aus `http/app.ts`): Verifier, Resolver,
 * Entscheidung, Replay-Schutz und Audit. Das Plugin registriert damit Hooks, Dekorationen und Routen; dieselbe Instanz
 * dient auch ausserhalb von Fastify (Tests, MCP-Dienst, Skripte).
 */
import { AccessService } from './access.ts';
import type { AuditPort } from './audit.ts';
import type { Catalog } from './catalog.ts';
import type { IamConfig } from './config.ts';
import { schemaName, withTenant, type Db, type Tx } from './db.ts';
import type { Principal } from './principal.ts';
import { PrincipalResolver } from './principal.ts';
import type { ResourceModel } from './resources.ts';
import { MemoryReplayStore, PgReplayStore, type ReplayStore } from './state.ts';
import { OidcProvider, TokenVerifier } from './tokens.ts';

/** Ereignis zu einer IAM-Änderung in derselben Transaktion (Assets: Outbox `acl.changed`). */
export type IamEvents = (tx: Tx, type: string, subject: string | null, data: Record<string, unknown>) => Promise<void>;

/**
 * Rollen und Gruppen einer Person in der Organisation wie im Token (für `GET /v1/acl/effective`); `null`: kein Mitglied
 * oder nicht bestimmbar. Setzt das Modul `admin` (Keycloak); ohne bleibt es bei der Simulation.
 */
export type MemberAccess = (tenantAlias: string, subject: string) => Promise<{ roles: string[]; groups: string[] } | null>;

export interface IamOptions<P extends string = string, S = unknown> {
  cfg: IamConfig;
  catalog: Catalog<P>;
  /** Pool der Laufzeit-Rolle (`<produkt>_runtime`). */
  db: Db;
  /** Schema der Tabellen (`<produkt>`). */
  schema: string;
  /** Ressourcen der Zugriffsregeln; ohne: Ressourcen direkt unter dem Mandanten. */
  resources?: ResourceModel<S> | null;
  audit: AuditPort;
  events?: IamEvents;
  /** Replay-Schutz (DPoP, Logout-Tokens); sonst nach `SHARED_STATE`. */
  replay?: ReplayStore;
  /** Abruf des Anmeldedienstes (Discovery, Tests). */
  fetch?: typeof fetch;
}

export interface Iam<P extends string = string, S = unknown> {
  readonly cfg: IamConfig;
  readonly catalog: Catalog<P>;
  readonly db: Db;
  readonly schema: string;
  readonly resources: ResourceModel<S> | null;
  readonly audit: AuditPort;
  readonly events: IamEvents | null;
  readonly replay: ReplayStore;
  readonly verifier: TokenVerifier;
  readonly resolver: PrincipalResolver;
  readonly access: AccessService<P, S>;
  /** Echte Rollen und Gruppen anderer Personen (setzt das Modul `admin`). */
  memberAccess: MemberAccess | null;
  /** Transaktion im Mandantenkontext des Principals mit dem Kontext der App (`resources.dbContext`). */
  tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Wie `tx`, aber mit voller Lesesicht der App (`resources.fullContext`, Entwurf 13.3). */
  fullTx<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export function createIam<P extends string, S = unknown>(o: IamOptions<P, S>): Iam<P, S> {
  const schema = schemaName(o.schema);
  const replay = o.replay ?? (o.cfg.ops.sharedState === 'postgres' ? new PgReplayStore(o.db, schema) : new MemoryReplayStore());
  const resources = o.resources ?? null;
  const access = new AccessService<P, S>(o.db, { catalog: o.catalog, schema, resources });
  return {
    cfg: o.cfg, catalog: o.catalog, db: o.db, schema, resources, audit: o.audit, events: o.events ?? null, replay,
    verifier: new TokenVerifier(new OidcProvider(o.cfg.oidc.issuer, o.fetch), o.cfg, replay),
    resolver: new PrincipalResolver(o.db, o.cfg, { schema }),
    access,
    memberAccess: null,
    async tx(p, fn) {
      const settings = resources?.dbContext ? await resources.dbContext(p, access as AccessService) : undefined;
      return withTenant(o.db, { tenantId: p.tenantId, principalId: p.principalId, settings }, fn);
    },
    fullTx(p, fn) {
      return withTenant(o.db, { tenantId: p.tenantId, principalId: p.principalId, settings: resources?.fullContext }, fn);
    },
  };
}

/** Prüfungen für `/readyz` der App: Name, fester Text für die Antwort (Fehlertexte nur ins Log), Prüfung. */
export function readinessChecks(iam: Pick<Iam, 'db' | 'verifier'>): { name: string; failure: string; run: () => Promise<unknown> }[] {
  return [
    { name: 'datenbank', failure: 'Datenbank nicht erreichbar', run: () => iam.db.query('SELECT 1') },
    { name: 'anmeldedienst', failure: 'Anmeldedienst nicht erreichbar oder falsch konfiguriert', run: () => iam.verifier.provider.probe() },
  ];
}
