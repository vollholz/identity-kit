/**
 * Rechtekatalog: Labels und Rollen aus dem Katalog, Sprache im Abruf und im Schlüssel, eigene Rollen der Organisation,
 * Gruppen der Rollen (V3). Aus vollholz/assets `web/src/auth/authz.test.tsx`, produktneutral (Notiz-App).
 */
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Can, groupRoles, makeAuthz, roleGroupProblems, useAuthz, useResourceCan, withCustomRoles, type IamConfig, type Role } from '../src/index.ts';
import { CATALOG, json, mockIamApi, StaticIam } from '../src/testing/index.tsx';

afterEach(() => vi.unstubAllGlobals());

const wrap = (config?: Partial<IamConfig>) => ({ children }: { children: ReactNode }) => <StaticIam config={config}>{children}</StaticIam>;

describe('Rechtekatalog', () => {
  it('Labels und Texte aus dem Katalog, Schlüssel solange er lädt', () => {
    const a = makeAuthz(CATALOG);
    expect(a.permLabel('note:write')).toBe('Notizen ändern');
    expect(a.roleLabel('folder-admin')).toBe('Ordner-Admin');
    expect(a.scopeText('notes:write')).toBe('Notizen ändern und löschen');
    expect(a.resourceLabel('folder')).toBe('Ordner');
    expect(a.permission('acl:admin')?.adminOnly).toBe(true);
    const empty = makeAuthz(undefined);
    expect(empty.permLabel('note:write')).toBe('note:write');
    expect(empty.roleLabel('editor')).toBe('editor');
    expect(empty.rolesWith('note:write')).toEqual([]);
    expect(empty.scopeText('notes:write')).toBe('');
  });

  it('rolesWith: Rollen mit dem Recht, org-admin zuletzt', () => {
    const a = makeAuthz(CATALOG);
    expect(a.rolesWith('note:write').map(r => r.key)).toEqual(['folder-admin', 'editor', 'org-admin']);
    expect(a.rolesWith('acl:admin').map(r => r.label)).toEqual(['Organisations-Admin']);
    expect(a.rolesWith('gibt:es-nicht')).toEqual([]);
  });

  it('useAuthz lädt GET /v1/authz/catalog in der Sprache der Texte (Accept-Language)', async () => {
    const api = mockIamApi();
    vi.stubGlobal('fetch', api.fetch);
    const { result } = renderHook(() => useAuthz(), { wrapper: wrap() });
    expect(result.current.permLabel('note:write')).toBe('note:write');
    await waitFor(() => expect(result.current.permLabel('note:write')).toBe('Notizen ändern'));
    const req = api.calls.find(c => new URL(c.url).pathname === '/v1/authz/catalog')!;
    expect(req.headers.get('accept-language')).toBe('de');
    expect(req.headers.get('x-tenant')).toBe('demo');
  });
});

describe('Eigene Rollen der Organisation', () => {
  const own: Role = { key: 'c-redaktion', label: 'Redaktion', description: 'Pflegt Notizen', permissions: ['note:read', 'note:write'], custom: true, adminOnly: false, id: 'x', version: 1, memberCount: null, createdAt: null, updatedAt: null };

  it('nach den vordefinierten im Katalog: Label und «Rollen mit Recht» kennen sie; Gruppe «Eigene Rollen»', () => {
    const a = makeAuthz(withCustomRoles(CATALOG, [own]));
    expect(a.roleLabel('c-redaktion')).toBe('Redaktion');
    expect(a.rolesWith('note:write').map(r => r.key)).toContain('c-redaktion');
    expect(a.rolesWith('note:write').at(-1)!.key).toBe('org-admin');
    const groups = a.groupRoles(a.catalog!.roles);
    expect(groups.map(g => [g.key, g.label])).toEqual([['org', 'Gesamte Organisation'], ['custom', 'Eigene Rollen'], ['other', 'Rollen']]);
    expect(groups[1]!.roles.map(r => r.key)).toEqual(['c-redaktion']);
    expect(withCustomRoles(CATALOG, [])).toBe(CATALOG);
  });

  it('ohne tenant:read auf Ebene der Organisation (Rechte nur über Freigaben): kein Abruf von /v1/roles', async () => {
    const api = mockIamApi();
    vi.stubGlobal('fetch', api.fetch);
    const wrapper = ({ children }: { children: ReactNode }) => <StaticIam me={{ roles: [], permissions: [], grantedPermissions: ['note:read'] }}>{children}</StaticIam>;
    const { result } = renderHook(() => useAuthz(), { wrapper });
    await waitFor(() => expect(result.current.catalog).toBeDefined());
    expect(api.calls.map(c => new URL(c.url).pathname)).not.toContain('/v1/roles');
  });

  it('useAuthz lädt sie aus /v1/roles; ohne Antwort bleibt der Schlüssel', async () => {
    vi.stubGlobal('fetch', mockIamApi({ 'GET /v1/roles': () => json({ items: [own], maxCustom: 50, customPermissions: [] }) }).fetch);
    const { result } = renderHook(() => useAuthz(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.roleLabel('c-redaktion')).toBe('Redaktion'));
    expect(makeAuthz(CATALOG).roleLabel('c-redaktion')).toBe('c-redaktion');
  });
});

describe('Gruppen der Rollen (roleGroups, V3)', () => {
  const roleGroups = [
    { key: 'org', label: 'Gesamte Organisation', roles: ['org-admin'] },
    { key: 'work', label: 'Arbeit', roles: ['editor', 'viewer'] },
    { key: 'control', label: 'Kontrolle', roles: ['auditor'] },
  ];

  it('in der Reihenfolge der App, nicht genannte unter «Weitere»', async () => {
    vi.stubGlobal('fetch', mockIamApi().fetch);
    const { result } = renderHook(() => useAuthz(), { wrapper: wrap({ roleGroups }) });
    await waitFor(() => expect(result.current.catalog).toBeDefined());
    const groups = result.current.groupRoles(result.current.catalog!.roles);
    expect(groups.map(g => [g.label, g.roles.map(r => r.key)])).toEqual([
      ['Gesamte Organisation', ['org-admin']], ['Arbeit', ['editor', 'viewer']], ['Kontrolle', ['auditor']], ['Weitere', ['folder-admin']],
    ]);
    expect(groupRoles([{ key: 'editor' }], [])).toEqual([{ key: 'other', label: 'Rollen', roles: [{ key: 'editor' }] }]);
  });

  it('roleGroupProblems: alle Schlüssel im Katalog, keine doppelt, keine eigenen Rollen', () => {
    expect(roleGroupProblems(roleGroups, CATALOG)).toEqual([]);
    expect(roleGroupProblems([...roleGroups, { key: 'x', label: 'X', roles: ['editor', 'schema-admin', 'c-redaktion'] }], CATALOG)).toEqual([
      'Rolle «editor» steht in mehreren Gruppen',
      'Gruppe «x»: Rolle «schema-admin» gibt es im Katalog nicht',
      'Gruppe «x»: Rolle «c-redaktion» gibt es im Katalog nicht',
      'Gruppe «x»: eigene Rolle «c-redaktion» gehört nicht in roleGroups',
    ]);
  });
});

describe('Rechte an der Stelle der Aktion', () => {
  it('Can zeigt nur mit Recht auf Ebene der Organisation; useResourceCan nimmt can der Ressource, sonst die Organisation', () => {
    function Probe() {
      const rc = useResourceCan();
      return <>
        <Can perm="note:write" fallback={<p>ohne Schreiben</p>}><p>Schreiben</p></Can>
        <p>{`res:${rc({ can: { write: true } }, 'write', 'note:delete')} ohne:${rc({ can: { write: false } }, 'write', 'note:write')} org:${rc<{ can?: { write: boolean } }>(null, 'write', 'note:write')}`}</p>
      </>;
    }
    const { unmount } = render(<StaticIam me={{ permissions: ['note:read', 'note:write'] }}><Probe /></StaticIam>);
    expect(screen.getByText('Schreiben')).toBeInTheDocument();
    expect(screen.getByText('res:true ohne:false org:true')).toBeInTheDocument();
    unmount();
    render(<StaticIam me={{ permissions: ['note:read'] }}><Probe /></StaticIam>);
    expect(screen.getByText('ohne Schreiben')).toBeInTheDocument();
    expect(screen.getByText('res:true ohne:false org:false')).toBeInTheDocument();
  });
});
