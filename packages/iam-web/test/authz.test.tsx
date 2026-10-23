/**
 * Rechtekatalog: Labels und Rollen aus dem Katalog, Orte und Stufen der Vertraulichkeit, Sprache im Abruf und im
 * Schlüssel, Gruppen der Rollen (V3). Aus vollholz/assets `web/src/auth/authz.test.tsx`, produktneutral (Notiz-App).
 */
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Can, groupRoles, makeAuthz, roleGroupProblems, useAccessFeature, useAuthz, useIam, useResourceCan, type IamConfig } from '../src/index.ts';
import { CATALOG, mockIamApi, StaticIam } from '../src/testing/index.tsx';

afterEach(() => vi.unstubAllGlobals());

const wrap = (config?: Partial<IamConfig>) => ({ children }: { children: ReactNode }) => <StaticIam config={config}>{children}</StaticIam>;

describe('Rechtekatalog', () => {
  it('Labels und Texte aus dem Katalog, Schlüssel solange er lädt', () => {
    const a = makeAuthz(CATALOG);
    expect(a.permLabel('note:write')).toBe('Notizen ändern');
    expect(a.roleLabel('folder-admin')).toBe('Ordner-Admin');
    expect(a.scopeText('notes:write')).toBe('Notizen ändern und löschen');
    expect(a.typeLabel('folder')).toBe('Ordner');
    expect(a.type('note')).toMatchObject({ leaf: true, classified: true, owner: true });
    expect(a.permission('members:admin')?.adminOnly).toBe(true);
    expect(a.relationLabel('member')).toBe('Mitglied');
    expect(a.relationLabel('owner')).toBe('Besitzer:in');
    expect(a.relationLabel('viewer')).toBe('Leser:in');
    expect(a.classificationLabel(2)).toBe('streng vertraulich');
    expect(a.hasPlaces).toBe(true);
    const empty = makeAuthz(undefined);
    expect(empty.permLabel('note:write')).toBe('note:write');
    expect(empty.roleLabel('editor')).toBe('editor');
    expect(empty.rolesWith('note:write')).toEqual([]);
    expect(empty.scopeText('notes:write')).toBe('');
    expect(empty.typeLabel('org')).toBe('Organisation');
    expect(empty.classificationLabel(1)).toBe('vertraulich');
    expect(empty.hasPlaces).toBe(false);
    expect(makeAuthz({ ...CATALOG, types: [CATALOG.types[0]!] }).hasPlaces).toBe(false);
  });

  it('rolesWith: Rollen mit dem Recht, org-admin zuletzt', () => {
    const a = makeAuthz(CATALOG);
    expect(a.rolesWith('note:write').map(r => r.key)).toEqual(['folder-admin', 'editor', 'org-admin']);
    expect(a.rolesWith('members:admin').map(r => r.label)).toEqual(['Organisations-Admin']);
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

describe('Rechte irgendwo und Orte', () => {
  it('canSomewhere nimmt somewhere aus /auth/me, can nur die Rechte an der Organisation', () => {
    function Probe() { const { can, canSomewhere } = useIam(); return <p>{`${can('note:write')} ${canSomewhere('note:write')} ${canSomewhere('audit:read')}`}</p>; }
    render(<StaticIam me={{ roles: [], permissions: ['tenant:read'], somewhere: ['tenant:read', 'note:write'] }}><Probe /></StaticIam>);
    expect(screen.getByText('false true false')).toBeInTheDocument();
  });

  it('useAccessFeature: features.access, sonst ob das Modell Orte ausser org hat', async () => {
    vi.stubGlobal('fetch', mockIamApi().fetch);
    const r1 = renderHook(() => useAccessFeature(), { wrapper: wrap() });
    await waitFor(() => expect(r1.result.current).toBe(true));
    const r2 = renderHook(() => useAccessFeature(), { wrapper: wrap({ features: { access: false } }) });
    expect(r2.result.current).toBe(false);
    vi.stubGlobal('fetch', mockIamApi({}, { catalog: { ...CATALOG, types: [CATALOG.types[0]!] } }).fetch);
    const r3 = renderHook(() => useAccessFeature(), { wrapper: wrap() });
    await waitFor(() => expect(r3.result.current).toBe(false));
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

  it('roleGroupProblems: alle Schlüssel im Katalog, keine doppelt', () => {
    expect(roleGroupProblems(roleGroups, CATALOG)).toEqual([]);
    expect(roleGroupProblems([...roleGroups, { key: 'x', label: 'X', roles: ['editor', 'schema-admin'] }], CATALOG)).toEqual([
      'Rolle «editor» steht in mehreren Gruppen',
      'Gruppe «x»: Rolle «schema-admin» gibt es im Katalog nicht',
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
