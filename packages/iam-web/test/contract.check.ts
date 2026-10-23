/**
 * Vertragstest auf Typebene (läuft mit `npm run typecheck`): Antworten der OpenAPI von Assets müssen sich den Typen des
 * Pakets zuweisen lassen (das Paket liest nur, was es gibt), und die Anfragekörper des Pakets haben dieselben Felder
 * wie die der OpenAPI und lassen jeden gültigen Körper der OpenAPI zu (Schlüssel der Rechte sind im Paket `string`, in
 * Assets eine Aufzählung). Weicht der Vertrag ab,
 * schlägt die Typprüfung hier fehl. Quelle: test/fixtures/openapi-iam.json (Auszug), erzeugt mit `npm run contract:types`.
 */
import type * as C from '../src/contract.ts';
import type { components, paths } from './fixtures/openapi-iam.d.ts';
import type { ME_FIXTURE } from './fixtures/me.ts';

type Json<R> = R extends { content: { 'application/json': infer B } } ? B : never;
type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> =
  paths[P][M] extends { responses: infer R } ? (S extends keyof R ? Json<R[S]> : never) : never;
type Body<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends { requestBody?: infer B } ? Json<NonNullable<B>> : never;

/** A lässt sich B zuweisen (sonst Typfehler an der Stelle des Aufrufs). */
type Fits<A, B> = [A] extends [B] ? true : { error: 'passt nicht'; from: A; to: B };
/** Gleiche Feldnamen und gleiche Pflichtfelder. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type SameKeys<A, B> = [keyof A, RequiredKeys<A>] extends [keyof B, RequiredKeys<B>]
  ? ([keyof B, RequiredKeys<B>] extends [keyof A, RequiredKeys<A>] ? true : { error: 'Felder fehlen im Paket'; paket: keyof A; vertrag: keyof B })
  : { error: 'Felder fehlen im Vertrag'; paket: keyof A; vertrag: keyof B };

const ok = <T extends true>(): T => true as T;
type S = components['schemas'];

// Antworten: Vertrag → Paket
ok<Fits<Res<'/auth/switch', 'post'>, C.SwitchResult>>();
ok<Fits<Res<'/v1/authz/catalog', 'get'>, C.AuthzCatalog>>();
ok<Fits<Res<'/v1/roles', 'get'>, C.RoleList>>();
ok<Fits<Res<'/v1/roles/{key}', 'get'>, C.Role>>();
ok<Fits<Res<'/v1/roles', 'post', 201>, C.Role>>();
ok<Fits<Res<'/v1/roles/{key}', 'patch'>, C.Role>>();
ok<Fits<Res<'/v1/admin/status', 'get'>, C.AdminStatus>>();
// Rollen im Status: gleiche Felder wie im Vertrag (die Seiten zeigen die Beschreibung)
ok<SameKeys<C.RoleInfo, Res<'/v1/admin/status', 'get'>['roles'][number]>>();
ok<Fits<Res<'/v1/admin/members', 'get'>, C.MemberList>>();
ok<Fits<Res<'/v1/admin/members', 'post', 202>, C.InviteResult>>();
ok<Fits<Res<'/v1/admin/members/{id}/roles', 'put'>, C.Member>>();
ok<Fits<Res<'/v1/admin/members/{id}', 'delete'>, C.RemoveResult>>();
ok<Fits<Res<'/v1/admin/members/{id}/invitation', 'post'>, C.ResendResult>>();
ok<Fits<Res<'/v1/admin/members/entra-search', 'get'>, C.EntraCandidateList>>();
ok<Fits<Res<'/v1/admin/members/entra', 'post', 202>, C.EntraAddResult>>();
ok<Fits<Res<'/v1/admin/clients', 'get'>, C.ClientGrantList>>();
ok<Fits<Res<'/v1/admin/clients/{clientId}', 'put'>, C.ClientGrant>>();
ok<Fits<Res<'/v1/admin/entra', 'get'>, C.EntraStatus>>();
ok<Fits<Res<'/v1/admin/entra/consent', 'post'>, C.EntraConsentStart>>();
ok<Fits<Res<'/v1/admin/entra/consent/complete', 'post'>, C.EntraResult>>();
ok<Fits<Res<'/v1/admin/entra/domains', 'put'>, C.EntraResult>>();
ok<Fits<Res<'/v1/admin/entra/enforce', 'post'>, C.EntraResult>>();
ok<Fits<Res<'/v1/admin/entra/refresh', 'post'>, C.EntraResult>>();
ok<Fits<Res<'/v1/admin/entra/preview', 'get'>, C.EntraPreview>>();
ok<Fits<Res<'/v1/admin/entra/test', 'post'>, C.EntraConnection>>();
ok<Fits<Res<'/v1/platform/organizations', 'get'>, C.OrganizationList>>();
ok<Fits<Res<'/v1/platform/organizations', 'post', 201>, C.Organization>>();
ok<Fits<Res<'/v1/platform/organizations/{alias}', 'get'>, C.Organization>>();
ok<Fits<Res<'/v1/platform/organizations/{alias}', 'patch'>, C.Organization>>();
ok<Fits<Res<'/v1/platform/organizations/{alias}/suspend', 'post'>, C.Organization>>();
ok<Fits<Res<'/v1/platform/organizations/{alias}/members', 'get'>, C.MemberList>>();
ok<Fits<Res<'/v1/platform/organizations/{alias}/clients', 'get'>, C.ClientGrantList>>();
ok<Fits<Res<'/v1/platform/organizations/{alias}/entra', 'get'>, C.EntraStatus>>();
ok<Fits<Res<'/v1/admin/entra/consent-links', 'get'>, C.ConsentLinkList>>();
ok<Fits<Res<'/v1/admin/entra/consent-links', 'post', 201>, C.ConsentLinkCreated>>();
ok<Fits<Res<'/v1/platform/organizations/{alias}/entra/consent-links', 'get'>, C.ConsentLinkList>>();
ok<Fits<Res<'/v1/platform/organizations/{alias}/entra/consent-links', 'post', 201>, C.ConsentLinkCreated>>();
ok<Fits<Res<'/v1/entra/handover/info', 'post'>, C.HandoverInfo>>();
ok<Fits<Res<'/v1/entra/handover/start', 'post'>, C.HandoverStart>>();
ok<Fits<Res<'/v1/entra/handover/complete', 'post'>, C.HandoverResult>>();
ok<Fits<Res<'/v1/entra/handover/credentials', 'post'>, C.HandoverResult>>();
ok<Fits<Res<'/v1/admin/entra/app', 'put'>, C.EntraResult>>();
ok<Fits<Res<'/v1/platform/organizations/{alias}/entra/app', 'put'>, C.EntraResult>>();
ok<Fits<Res<'/v1/acl', 'get'>, C.AclList>>();
ok<Fits<Res<'/v1/acl', 'post', 201>, C.AclEntry>>();
ok<Fits<Res<'/v1/acl/effective', 'get'>, C.Effective>>();
ok<Fits<Res<'/v1/people', 'get'>, C.PersonList>>();
ok<Fits<Res<'/v1/people/{id}', 'get'>, C.PersonEntry>>();
ok<Fits<S['ValidationProblem'] & S['VersionConflict'] & S['OrganizationChoice'], C.ProblemDetails>>();

// /auth/me (5.1, nicht in der OpenAPI): gleiche Felder und Pflichtfelder wie die Fixture; Pflicht u. a. tenant.name,
// organizationNames, grantedPermissions
ok<SameKeys<C.Me, typeof ME_FIXTURE>>();
ok<SameKeys<NonNullable<C.Me['tenant']>, NonNullable<(typeof ME_FIXTURE)['tenant']>>>();

// Anfragekörper: gleiche Felder wie im Vertrag
ok<SameKeys<C.SwitchInput, Omit<Body<'/auth/switch', 'post'>, 'csrf'>>>();
ok<SameKeys<C.RoleInput, Body<'/v1/roles', 'post'>>>();
ok<SameKeys<C.RolePatch, Body<'/v1/roles/{key}', 'patch'>>>();
ok<SameKeys<C.InviteInput, Body<'/v1/admin/members', 'post'>>>();
ok<SameKeys<C.RolesInput, Body<'/v1/admin/members/{id}/roles', 'put'>>>();
ok<SameKeys<C.EntraAddInput, Body<'/v1/admin/members/entra', 'post'>>>();
ok<SameKeys<C.ClientGrantInput, Body<'/v1/admin/clients/{clientId}', 'put'>>>();
ok<SameKeys<C.EntraConsentInput, Body<'/v1/admin/entra/consent', 'post'>>>();
ok<SameKeys<C.EntraConsentReturn, Body<'/v1/admin/entra/consent/complete', 'post'>>>();
ok<SameKeys<C.EntraDomainsInput, Body<'/v1/admin/entra/domains', 'put'>>>();
ok<SameKeys<C.EntraEnforceInput, Body<'/v1/admin/entra/enforce', 'post'>>>();
ok<SameKeys<C.ConsentLinkInput, Body<'/v1/admin/entra/consent-links', 'post'>>>();
ok<SameKeys<C.EntraOwnAppInput, Body<'/v1/admin/entra/app', 'put'>>>();
ok<SameKeys<C.HandoverCredentialsInput, Body<'/v1/entra/handover/credentials', 'post'>>>();
ok<SameKeys<C.HandoverToken, Body<'/v1/entra/handover/info', 'post'>>>();
ok<SameKeys<C.EntraConsentReturn, Body<'/v1/entra/handover/complete', 'post'>>>();
ok<SameKeys<C.OrganizationInput, Body<'/v1/platform/organizations', 'post'>>>();
ok<SameKeys<C.OrganizationPatch, Body<'/v1/platform/organizations/{alias}', 'patch'>>>();
ok<SameKeys<C.AclInput, Body<'/v1/acl', 'post'>>>();

// Anfragekörper: jeder gültige Körper des Vertrags lässt sich mit dem Typ des Paketes ausdrücken (z. B. `null` zum Leeren)
ok<Fits<Omit<Body<'/auth/switch', 'post'>, 'csrf'>, C.SwitchInput>>();
ok<Fits<Body<'/v1/roles', 'post'>, C.RoleInput>>();
ok<Fits<Body<'/v1/roles/{key}', 'patch'>, C.RolePatch>>();
ok<Fits<Body<'/v1/admin/members', 'post'>, C.InviteInput>>();
ok<Fits<Body<'/v1/admin/members/{id}/roles', 'put'>, C.RolesInput>>();
ok<Fits<Body<'/v1/admin/members/entra', 'post'>, C.EntraAddInput>>();
ok<Fits<Body<'/v1/admin/clients/{clientId}', 'put'>, C.ClientGrantInput>>();
ok<Fits<Body<'/v1/admin/entra/consent', 'post'>, C.EntraConsentInput>>();
ok<Fits<Body<'/v1/admin/entra/consent/complete', 'post'>, C.EntraConsentReturn>>();
ok<Fits<Body<'/v1/admin/entra/domains', 'put'>, C.EntraDomainsInput>>();
ok<Fits<Body<'/v1/admin/entra/enforce', 'post'>, C.EntraEnforceInput>>();
ok<Fits<Body<'/v1/admin/entra/consent-links', 'post'>, C.ConsentLinkInput>>();
ok<Fits<Body<'/v1/admin/entra/app', 'put'>, C.EntraOwnAppInput>>();
ok<Fits<Body<'/v1/entra/handover/credentials', 'post'>, C.HandoverCredentialsInput>>();
ok<Fits<Body<'/v1/entra/handover/start', 'post'>, C.HandoverToken>>();
ok<Fits<Body<'/v1/entra/handover/complete', 'post'>, C.EntraConsentReturn>>();
ok<Fits<Body<'/v1/platform/organizations', 'post'>, C.OrganizationInput>>();
ok<Fits<Body<'/v1/platform/organizations/{alias}', 'patch'>, C.OrganizationPatch>>();
// `effect: 'allow'` ist der alte Name von `restrict`; der Vertrag nimmt ihn noch an, das Paket sendet ihn nie
ok<Fits<Omit<Body<'/v1/acl', 'post'>, 'effect'> & { effect?: Exclude<Body<'/v1/acl', 'post'>['effect'], 'allow'> }, C.AclInput>>();
