import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Frisches Modul je Test: der Speicher wird beim Laden bestimmt (wie ein neuer Tab). */
const load = async () => { vi.resetModules(); return import('../src/tabOrg.ts'); };

beforeEach(() => sessionStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Organisation je Tab', () => {
  it('merkt sich die Wahl im sessionStorage unter iam.tab.org', async () => {
    const m = await load();
    expect(m.readTabOrg()).toBeNull();
    m.writeTabOrg({ sub: 'sub-anna', alias: 'muster', name: 'Muster GmbH' });
    expect(JSON.parse(sessionStorage.getItem('iam.tab.org')!)).toEqual({ sub: 'sub-anna', alias: 'muster', name: 'Muster GmbH' });
    expect((await load()).readTabOrg()).toEqual({ sub: 'sub-anna', alias: 'muster', name: 'Muster GmbH' });
    m.writeTabOrg(null);
    expect(sessionStorage.getItem('iam.tab.org')).toBeNull();
  });

  it('verwirft die Wahl einer anderen Person im selben Tab', async () => {
    const m = await load();
    m.writeTabOrg({ sub: 'sub-anna', alias: 'muster' });
    expect(m.tabOrgFor('sub-anna')).toEqual({ sub: 'sub-anna', alias: 'muster', name: undefined });
    expect(m.tabOrgFor('sub-ben')).toBeNull();
    expect(m.readTabOrg()).toBeNull();
  });

  it('ignoriert ungültige Einträge', async () => {
    sessionStorage.setItem('iam.tab.org', '{kaputt');
    expect((await load()).readTabOrg()).toBeNull();
    sessionStorage.setItem('iam.tab.org', JSON.stringify({ alias: 'demo' }));
    expect((await load()).readTabOrg()).toBeNull();
  });

  it('übernimmt einen früheren Schlüssel einmal und löscht ihn', async () => {
    sessionStorage.setItem('assets.tab.org', JSON.stringify({ sub: 'sub-anna', alias: 'muster', name: 'Muster GmbH' }));
    const m = await load();
    m.adoptLegacyTabOrg('assets.tab.org');
    expect(m.readTabOrg()).toEqual({ sub: 'sub-anna', alias: 'muster', name: 'Muster GmbH' });
    expect(sessionStorage.getItem('assets.tab.org')).toBeNull();
  });

  it('überschreibt beim Übernehmen keine neuere Wahl', async () => {
    sessionStorage.setItem('assets.tab.org', JSON.stringify({ sub: 'sub-anna', alias: 'alt' }));
    sessionStorage.setItem('iam.tab.org', JSON.stringify({ sub: 'sub-anna', alias: 'neu' }));
    const m = await load();
    m.adoptLegacyTabOrg('assets.tab.org');
    expect(m.readTabOrg()?.alias).toBe('neu');
    expect(sessionStorage.getItem('assets.tab.org')).toBeNull();
    m.adoptLegacyTabOrg(undefined);
    expect(m.readTabOrg()?.alias).toBe('neu');
  });

  it('gilt ohne Speicher bis zum Neuladen (gesperrt, privates Fenster)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('gesperrt'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('gesperrt'); });
    const m = await load();
    m.adoptLegacyTabOrg('assets.tab.org');
    expect(m.readTabOrg()).toBeNull();
    m.writeTabOrg({ sub: 'sub-anna', alias: 'demo' });
    expect(m.readTabOrg()).toEqual({ sub: 'sub-anna', alias: 'demo' });
  });
});
