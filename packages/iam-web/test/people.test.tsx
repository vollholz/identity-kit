/**
 * Personenverzeichnis (docs/entwurf.md 1.8): `<PersonName>` löst gesammelt auf (ein Aufruf mit `ids` je Augenblick),
 * zeigt bis dahin die gekürzte ID, unbekannte Personen mit Hinweis; Suchtreffer füllen den Zwischenspeicher; eine App
 * ersetzt das Verzeichnis über `people`.
 */
import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonName, searchPeople, type IamPeople } from '../src/index.ts';
import { defaultPeople } from '../src/people.tsx';
import { json, mockIamApi, StaticIam } from '../src/testing/index.tsx';

afterEach(() => vi.unstubAllGlobals());

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const GONE = '00000000-0000-4000-8000-0000000000ff';
const person = (id: string, name: string) => ({ id, kind: 'user', name, email: `${name.toLowerCase().split(' ')[0]}@demo.example`, clientId: null, lastSeenAt: null });

describe('Personenverzeichnis', () => {
  it('PersonName: ein Aufruf für alle Namen einer Darstellung, gekürzte ID bis zur Antwort, Unbekannte mit Hinweis', async () => {
    const api = mockIamApi({ 'GET /v1/people': req => {
      const ids = new URL(req.url).searchParams.getAll('ids');
      return json({ items: [person(A, 'Anna Admin'), person(B, 'Bruno Beispiel')].filter(p => ids.includes(p.id)), nextCursor: null });
    } });
    vi.stubGlobal('fetch', api.fetch);
    render(<StaticIam><ul><li><PersonName id={A} /></li><li><PersonName id={B} /></li><li><PersonName id={GONE} /></li><li><PersonName id={A} /></li></ul></StaticIam>);
    expect(screen.getAllByText('00000000')).toHaveLength(4);
    expect(await screen.findAllByText('Anna Admin')).toHaveLength(2);
    expect(screen.getByText('Bruno Beispiel')).toHaveAttribute('title', 'bruno@demo.example');
    expect(await screen.findByText('Unbekannte Person 00000000')).toBeInTheDocument();
    const people = api.calls.filter(c => new URL(c.url).pathname === '/v1/people');
    expect(people).toHaveLength(1);
    expect(new URL(people[0]!.url).searchParams.getAll('ids').sort()).toEqual([A, B, GONE].sort());
  });

  it('Standard-Adapter: Suche nur Personen (keine Maschinen-Clients), höchstens 20; Auflösung in Blöcken zu 100 IDs', async () => {
    const api = mockIamApi({ 'GET /v1/people': req => {
      const u = new URL(req.url);
      if (u.searchParams.has('q')) return json({ items: [person(A, 'Anna Admin'), { ...person(B, 'ci-bot'), kind: 'client', clientId: 'ci-bot' }], nextCursor: null });
      return json({ items: u.searchParams.getAll('ids').map(id => person(id, 'X')), nextCursor: null });
    } });
    vi.stubGlobal('fetch', api.fetch);
    expect(await defaultPeople.search(' anna ', new AbortController().signal)).toEqual([{ id: A, name: 'Anna Admin', email: 'anna@demo.example' }]);
    expect(Object.fromEntries(new URL(api.calls[0]!.url).searchParams)).toEqual({ limit: '20', q: 'anna' });
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    expect(await defaultPeople.resolve(ids, new AbortController().signal)).toHaveLength(150);
    expect(api.calls.slice(1).map(c => new URL(c.url).searchParams.getAll('ids').length)).toEqual([100, 50]);
  });

  it('eigenes Verzeichnis der App ersetzt /v1/people; Suchtreffer füllen den Zwischenspeicher', async () => {
    const api = mockIamApi();
    vi.stubGlobal('fetch', api.fetch);
    const people: IamPeople = {
      search: vi.fn(async () => [{ id: A, name: 'Anna Admin', email: null }]),
      resolve: vi.fn(async (ids: string[]) => ids.filter(id => id === B).map(id => ({ id, name: 'Bruno Beispiel', email: null }))),
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await searchPeople(qc, people, 'an', new AbortController().signal);
    render(<StaticIam queryClient={qc} config={{ people }}><PersonName id={A} /> <PersonName id={B} /></StaticIam>);
    expect(screen.getByText('Anna Admin')).toBeInTheDocument();
    expect(await screen.findByText('Bruno Beispiel')).toBeInTheDocument();
    await waitFor(() => expect(people.resolve).toHaveBeenCalledTimes(1));
    expect(vi.mocked(people.resolve).mock.calls[0]![0]).toEqual([B.toLowerCase()]);
    expect(api.calls.some(c => new URL(c.url).pathname === '/v1/people')).toBe(false);
  });
});
