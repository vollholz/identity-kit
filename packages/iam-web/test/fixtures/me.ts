/**
 * `/auth/me` nach Spezifikation 9.5 mit allen Feldern; `test/contract.check.ts` hält damit den Typ `Me` fest (gleiche
 * Felder, gleiche Pflichtfelder). Die OpenAPI von Assets beschreibt `/auth/me` nicht.
 */
import type { Me } from '../../src/contract.ts';

export const ME_FIXTURE = {
  person: { subject: 'sub-anna', name: 'Anna Admin', email: 'anna@demo.example' },
  tenant: { id: 't1', alias: 'demo', name: 'Demo AG', entraConnected: false },
  organizations: ['demo', 'muster'],
  organizationNames: { demo: 'Demo AG', muster: 'Muster GmbH' },
  selectedOrganization: 'demo',
  tenantError: null,
  roles: ['org-admin'],
  permissions: ['tenant:read'],
  somewhere: ['tenant:read', 'note:read'],
  clearance: 2,
  breakGlassUntil: null,
  breakGlassAllowed: true,
  csrfToken: 'csrf-123',
  session: { expiresAt: '2030-01-01T00:00:00.000Z', idleTimeoutSeconds: 3600 },
} satisfies Me;
