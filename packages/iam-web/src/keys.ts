/**
 * Abfrageschlüssel des Pakets (TanStack Query). Alle beginnen mit 'iam'; beim Wechsel der Organisation bleibt nur
 * `['iam', 'me']`. Die App invalidiert damit nach eigenen Änderungen (z. B. `qc.invalidateQueries({ queryKey: iamKeys.roles })`).
 */
export const iamKeys = {
  all: ['iam'] as const,
  me: ['iam', 'me'] as const,
  catalog: (locale: string) => ['iam', 'catalog', locale] as const,
  roles: ['iam', 'roles'] as const,
  adminStatus: ['iam', 'admin', 'status'] as const,
  members: (alias: string | null) => ['iam', 'admin', 'members', alias ?? '_own'] as const,
  clients: (alias: string | null) => ['iam', 'admin', 'clients', alias ?? '_own'] as const,
  entra: (alias: string | null) => ['iam', 'admin', 'entra', alias ?? '_own'] as const,
  consentLinks: (alias: string | null) => ['iam', 'admin', 'entra', alias ?? '_own', 'links'] as const,
  orgs: ['iam', 'admin', 'orgs'] as const,
  org: (alias: string) => ['iam', 'admin', 'orgs', alias] as const,
  acl: ['iam', 'acl'] as const,
  aclEffective: (query: object) => ['iam', 'acl', 'effective', query] as const,
  person: (id: string) => ['iam', 'people', 'one', id] as const,
  peopleSearch: (q: string) => ['iam', 'people', 'search', q] as const,
};
