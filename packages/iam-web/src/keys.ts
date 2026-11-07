/**
 * Abfrageschlüssel des Pakets (TanStack Query). Alle beginnen mit 'iam'; beim Wechsel der Organisation bleibt nur
 * `['iam', 'me']`. Die App invalidiert damit nach eigenen Änderungen (z. B. `qc.invalidateQueries({ queryKey: iamKeys.access })`).
 */
export const iamKeys = {
  all: ['iam'] as const,
  me: ['iam', 'me'] as const,
  catalog: (locale: string) => ['iam', 'catalog', locale] as const,
  adminStatus: ['iam', 'admin', 'status'] as const,
  /** `GET /v1/account` (bleibt beim Wechsel der Organisation gültig, gehört aber zur Person). */
  account: ['iam', 'account'] as const,
  members: (alias: string | null) => ['iam', 'admin', 'members', alias ?? '_own'] as const,
  clients: (alias: string | null) => ['iam', 'admin', 'clients', alias ?? '_own'] as const,
  /** Eigene Rollen der Organisation (`/v1/admin/roles`). */
  customRoles: (alias: string | null) => ['iam', 'admin', 'roles', alias ?? '_own'] as const,
  entra: (alias: string | null) => ['iam', 'admin', 'entra', alias ?? '_own'] as const,
  consentLinks: (alias: string | null) => ['iam', 'admin', 'entra', alias ?? '_own', 'links'] as const,
  orgs: ['iam', 'admin', 'orgs'] as const,
  org: (alias: string) => ['iam', 'admin', 'orgs', alias] as const,
  /** Alles unter «Zugriff» (Liste je Ort, eigene und fremde Orte, «Warum?», Gruppen); nach jeder Änderung invalidiert. */
  access: ['iam', 'access'] as const,
  accessList: (type: string, id: string | null) => ['iam', 'access', 'list', type, id ?? ''] as const,
  accessOf: (subject: string) => ['iam', 'access', 'subject', subject] as const,
  explain: (type: string, id: string | null, permission: string, subject: string) => ['iam', 'access', 'explain', type, id ?? '', permission, subject] as const,
  accessGroups: (q: string) => ['iam', 'access', 'groups', q] as const,
  person: (id: string) => ['iam', 'people', 'one', id] as const,
  peopleSearch: (q: string) => ['iam', 'people', 'search', q] as const,
};
