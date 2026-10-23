/** Testhilfen für Apps: feste Sitzung, Nachbildung des Vertrags, Beispielkatalog nach Spezifikation 8.1. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { iamKeys, useIam } from '../src/index.ts';
import { CATALOG, json, ME, mockIamApi, StaticIam } from '../src/testing/index.tsx';

describe('Testhilfen', () => {
  it('staticResources: Namen je Ort, unbekannte nicht sichtbar, open nur mit Angabe', async () => {
    const { staticResources } = await import('../src/testing/index.tsx');
    const open = vi.fn();
    const r = staticResources({ folder: { f1: 'Projekte' } }, { open });
    const resolver = r.useResolver();
    expect(resolver.name({ type: 'folder', id: 'f1' })).toBe('Projekte');
    expect(resolver.name({ type: 'folder', id: 'f2' })).toBeUndefined();
    expect(resolver.name({ type: 'org', id: null })).toBeUndefined();
    r.open!({ type: 'folder', id: 'f1' });
    expect(open).toHaveBeenCalledWith({ type: 'folder', id: 'f1' });
    expect(staticResources({}).open).toBeUndefined();
  });

  it('StaticIam: feste Sitzung mit Überschreibungen, Organisation als X-Tenant', async () => {
    function Probe() { const { me, orgName, can } = useIam(); return <p>{`${me.person.name} in ${orgName}, lesen:${can('note:read')}`}</p>; }
    render(<StaticIam me={{ tenant: { id: 't2', alias: 'muster', name: 'Muster GmbH' }, permissions: [] }}><Probe /></StaticIam>);
    expect(screen.getByText('Anna Admin in Muster GmbH, lesen:false')).toBeInTheDocument();
    const { tenantHeaders } = await import('../src/index.ts');
    expect(tenantHeaders('GET')).toEqual({ 'X-Tenant': 'muster' });
  });

  it('StaticIam: Sprache und Texte wie bei IamProvider', async () => {
    const { MissingRight } = await import('../src/index.ts');
    vi.stubGlobal('fetch', mockIamApi().fetch);
    render(<StaticIam locale="en" texts={{ en: { 'iam.missing.lead': 'To do this' } }}><MissingRight perm="note:write" /></StaticIam>);
    expect(await screen.findByText(/^To do this you lack the permission «Notizen ändern»/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('mockIamApi: Standardantworten, eigene Routen, 404 sonst, Aufrufe gesammelt', async () => {
    const api = mockIamApi({ 'POST /v1/notes': () => json({ id: 'n1' }, 201) });
    expect(await (await api.fetch('http://localhost/auth/me')).json()).toEqual(ME);
    expect(await (await api.fetch('http://localhost/v1/authz/catalog')).json()).toEqual(CATALOG);
    expect((await api.fetch('http://localhost/v1/notes', { method: 'POST' })).status).toBe(201);
    const nf = await api.fetch('http://localhost/v1/gibt-es-nicht');
    expect(nf.status).toBe(404);
    expect(nf.headers.get('content-type')).toBe('application/problem+json');
    expect(api.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /auth/me', 'GET /v1/authz/catalog', 'POST /v1/notes', 'GET /v1/gibt-es-nicht']);
  });

  it('Beispielmodell: reservierte Namen nach 8.1, org-admin mit allen Rechten, members:admin und access:admin in keinem Scope, Orte', () => {
    const keys = CATALOG.permissions.map(p => p.key);
    for (const k of ['tenant:read', 'tenant:admin', 'members:admin', 'access:admin', 'audit:read']) expect(keys).toContain(k);
    expect(keys.filter(k => k.startsWith('acl:'))).toEqual([]);
    expect(CATALOG.types.map(x => [x.key, x.parent])).toEqual([['org', null], ['folder', 'org'], ['note', 'folder']]);
    expect(CATALOG.types[0]!.roles).toEqual(CATALOG.roles.map(r => r.key));
    expect(CATALOG.scopes.flatMap(s => s.permissions)).not.toContain('access:admin');
    expect(CATALOG.permissions.find(p => p.key === 'members:admin')).toMatchObject({ label: 'Mitglieder und Rollen verwalten', group: 'members' });
    expect([...CATALOG.roles.find(r => r.key === 'org-admin')!.permissions].sort()).toEqual([...keys].sort());
    expect(CATALOG.scopes.flatMap(s => s.permissions)).not.toContain('members:admin');
    expect(iamKeys.catalog('de')).toEqual(['iam', 'catalog', 'de']);
  });
});
