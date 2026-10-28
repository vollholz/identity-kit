/**
 * Abhängigkeiten des IAM einmal gebaut (Spezifikation Kap. 15.2): Verifier, Resolver, Entscheidung, Tupel, Auskunft,
 * Replay-Schutz und Audit. Das Plugin registriert damit Hooks, Dekorationen und Routen; dieselbe Instanz dient auch
 * ausserhalb von Fastify (Worker, MCP-Dienst, Tests, Skripte).
 */
import { AccessService, fullView } from './access.ts';
import { AdminService } from './admin.ts';
import { Bff, type BffOptions } from './bff.ts';
import { withPlatformAudit, type AuditPort } from './audit.ts';
import type { IamConfig } from './config.ts';
import { schemaName, withTenant, type Db, type Tx } from './db.ts';
import { EntraService } from './entra.ts';
import { AccessInfo } from './explain.ts';
import { EntraGraph } from './graph.ts';
import { KeycloakAdmin } from './keycloak.ts';
import { ModelError, type Model } from './model.ts';
import type { Principal } from './principal.ts';
import { PrincipalResolver } from './principal.ts';
import type { ResourceModel } from './resources.ts';
import { MemoryReplayStore, PgReplayStore, type ReplayStore } from './state.ts';
import { OidcProvider, TokenVerifier } from './tokens.ts';
import { TupleStore } from './tuples.ts';
import { CustomRoles } from './roles.ts';
import type { IamEvents } from './events.ts';

export type { IamEvents } from './events.ts';

export interface IamOptions<P extends string = string, S = unknown> {
  cfg: IamConfig;
  model: Model<P>;
  /** Pool der Laufzeit-Rolle (`<produkt>_runtime`). */
  db: Db;
  /** Schema der Tabellen (`<produkt>`). */
  schema: string;
  /** Ressourcen der App (Kette, Existenz, Klassifizierung, Zuständigkeit); ohne: Typen direkt unter der Organisation. */
  resources?: ResourceModel<S> | null;
  audit: AuditPort;
  /**
   * Haken der App vor und nach Änderungen (events.ts): `member.removing` (darf ablehnen), `member.removed`,
   * `access.granted`, `access.revoked`, `access.expired`; im Worker dieselben Haken an `MemberSync` geben.
   */
  events?: IamEvents | null;
  /** Replay-Schutz (DPoP, Logout-Tokens); sonst nach `SHARED_STATE`. */
  replay?: ReplayStore;
  /** Abruf des Anmeldedienstes (Discovery, Tests). */
  fetch?: typeof fetch;
  /** Abruf der Keycloak-Admin-API (Verwaltung; Tests: `KeycloakFake.fetch`); Standard `fetch`. */
  keycloakFetch?: typeof fetch;
  /** Abruf bei Microsoft (Entra ID, Graph; Tests: Nachbildung); Standard `fetch`. */
  entraFetch?: typeof fetch;
  /** Wartezeiten nach der Admin-Zustimmung, bis die Rechte bei Microsoft gelten (Tests: `[0]`). */
  entraRetryMs?: number[];
  /**
   * Anmeldung der Oberfläche: gebaut, wenn `OIDC_BFF_CLIENT_SECRET` oder `OIDC_BFF_PRIVATE_KEY` gesetzt ist (dann sind
   * `SESSION_SECRET` und in Produktion `ENCRYPTION_KEYS` Pflicht); `false` schaltet es ab (z. B. MCP-Dienst).
   */
  bff?: false | BffOptions;
}

export interface Iam<P extends string = string, S = unknown> {
  readonly cfg: IamConfig;
  readonly model: Model<P>;
  readonly db: Db;
  readonly schema: string;
  readonly resources: ResourceModel<S> | null;
  readonly audit: AuditPort;
  readonly events: IamEvents | null;
  readonly replay: ReplayStore;
  readonly verifier: TokenVerifier;
  readonly resolver: PrincipalResolver;
  readonly access: AccessService<P, S>;
  /** Tupel lesen und schreiben (z. B. `owner` beim Anlegen einer Ressource). */
  readonly tuples: TupleStore;
  /** Eigene Rollen der Organisation (Modul `roles`); null mit `features.customRoles: false`. */
  readonly roles: CustomRoles | null;
  /** «Wer hat Zugriff?», «Warum?», wer vergeben darf. */
  readonly info: AccessInfo;
  /** Anmeldung der Oberfläche (`SessionBridge` des Plugins, Modul `bff`) oder null. */
  readonly bff: Bff | null;
  /** Verwaltung von Organisationen und Mitgliedern (Keycloak); null ohne `KEYCLOAK_MGMT_CLIENT_ID`. */
  readonly admin: AdminService | null;
  /** Anmeldung über Microsoft Entra ID je Organisation (Modul `entra`); null ohne Verwaltung. */
  readonly entra: EntraService | null;
  /** Transaktion im Mandantenkontext des Principals mit der Lesesicht der Anfrage (Kap. 7.6). */
  tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Wie `tx`, aber mit voller Sicht (interne Prüfungen; Inhalte gehen nie an die Person zurück). */
  fullTx<T>(p: Pick<Principal, 'tenantId' | 'principalId'>, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** Passt das ResourceModel zum Modell? (M8 `edges.unit`, Pflichtteile je Schalter) */
export function resourceProblems(model: Model, r: ResourceModel<any> | null): string[] {
  const out: string[] = [];
  const types = [...model.types.values()];
  // Ohne version bliebe der geladene Zustand der Kette bis zur nächsten Änderung eines Tupels im Zwischenspeicher
  if (r?.load && !r.version) out.push('ResourceModel.version fehlt (Pflicht mit load: ändert sich mit jeder Änderung der Kette)');
  if (types.some(t => t.classified) && !r?.classification) out.push('ResourceModel.classification fehlt (Typen mit classified)');
  if (types.some(t => t.scope)) {
    const e = r?.edges;
    const unitParts = [e?.unit, e?.children, e?.belongs].filter(Boolean).length;
    if (!e || (!unitParts && !e.persons)) out.push('ResourceModel.edges fehlt (Typen mit scope: unit, children und belongs oder persons)');
    else if (unitParts && unitParts < 3) out.push('ResourceModel.edges: unit, children und belongs nur gemeinsam');
    else if (unitParts && !model.types.get(e.unit as never)?.member) out.push(`ResourceModel.edges.unit «${e.unit}» hat «member» nicht in relations (M8)`);
    if (e?.personGrants && !e.persons) out.push('ResourceModel.edges.personGrants ohne persons');
  }
  return out;
}

export function createIam<P extends string, S = unknown>(o: IamOptions<P, S>): Iam<P, S> {
  const schema = schemaName(o.schema);
  const resources = o.resources ?? null;
  const problems = resourceProblems(o.model, resources);
  const access = new AccessService<P, S>(o.db, { model: o.model, schema, resources });
  const ids = access.readTypesProblem();
  if (ids) problems.push(ids);
  if (problems.length) throw new ModelError(problems);
  const replay = o.replay ?? (o.cfg.ops.sharedState === 'postgres' ? new PgReplayStore(o.db, schema) : new MemoryReplayStore());
  const provider = new OidcProvider(o.cfg.oidc.issuer, o.fetch);
  const wantsBff = o.bff !== false && !!(o.cfg.oidc.bffClientSecret || o.cfg.oidc.bffPrivateKey);
  const bff = wantsBff ? new Bff(o.cfg, o.db, provider, { replay, ...(o.bff || {}), schema, product: o.model.product }) : null;
  const resolver = new PrincipalResolver(o.db, o.cfg, { schema, access: access as AccessService });
  // Plattform-Administration steht zusätzlich im Protokoll der Plattform
  const audit = withPlatformAudit(o.audit);
  const events = o.events ?? null;
  const tuples = new TupleStore({ schema, model: o.model, audit, events });
  const deps = { cfg: o.cfg, model: o.model, db: o.db, schema, audit, resolver, access: access as AccessService, tuples, events };
  const admin = o.cfg.mgmt.clientId
    ? new AdminService(deps, new KeycloakAdmin(o.cfg, async () => (await provider.discovery()).token_endpoint, o.keycloakFetch))
    : null;
  const e = o.cfg.entra;
  const graph = e.clientId && e.clientSecret ? new EntraGraph({ clientId: e.clientId, clientSecret: e.clientSecret, timeoutMs: e.timeoutMs }, o.entraFetch) : null;
  const entra = admin ? new EntraService(deps, admin, graph, { retryMs: o.entraRetryMs, fetch: o.entraFetch }) : null;
  const info = new AccessInfo(access, { groupNames: entra ? (tenantId, groupIds) => entra.groupNames(tenantId, groupIds) : null });
  return {
    cfg: o.cfg, model: o.model, db: o.db, schema, resources, audit, events, replay,
    verifier: new TokenVerifier(provider, o.cfg, replay),
    resolver, access, tuples, info, bff, admin, entra,
    roles: o.model.features.customRoles ? new CustomRoles({ schema, access: access as AccessService, audit }) : null,
    async tx(p, fn) {
      const acl = await access.load(p.tenantId);
      const settings = await access.readView(p.tenantId, p, acl);
      return withTenant(o.db, { tenantId: p.tenantId, principalId: p.principalId, settings }, fn);
    },
    fullTx(p, fn) {
      return withTenant(o.db, { tenantId: p.tenantId, principalId: p.principalId, settings: fullView(o.model) }, fn);
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
