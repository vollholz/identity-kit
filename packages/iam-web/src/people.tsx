/**
 * Personenverzeichnis (docs/entwurf.md 1.8, Spezifikation 9.2 `GET /v1/people`): Suche für Auswahlen und Auflösung von
 * Principal-IDs zu Namen. Die Standard-Umsetzung ruft `/v1/people` auf; eine App mit eigenem Verzeichnis ersetzt sie
 * über `people`. `<PersonName>` sammelt die Einzelabfragen eines Augenblicks (z. B. einer Tabelle) zu einem Aufruf mit
 * höchstens 100 IDs; Suchtreffer füllen denselben Zwischenspeicher. Herkunft: vollholz/assets `web/src/api/people.ts`.
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { iamFetch } from './client.ts';
import { useIamConfig } from './config.tsx';
import type { PersonList } from './contract.ts';
import { shortId } from './format.ts';
import { iamKeys } from './keys.ts';
import { ApiError } from './problem.ts';
import { t } from './texts/index.ts';
import { useIamText } from './texts/react.tsx';

/** `id` = Principal-ID in dieser Organisation. */
export interface IamPerson { id: string; name: string; email: string | null }

export interface IamPeople {
  /** Höchstens 20 Treffer (Name, E-Mail). */
  search(q: string, signal: AbortSignal): Promise<IamPerson[]>;
  /** Fehlende IDs fehlen in der Antwort (wie ein 404). */
  resolve(ids: string[], signal: AbortSignal): Promise<IamPerson[]>;
}

const BATCH_MAX = 100;
const toPerson = (p: { id: string; name: string; email: string | null }): IamPerson => ({ id: p.id, name: p.name, email: p.email });

/** Standard: `GET /v1/people?q=&limit=` und `?ids=…` (wiederholt, höchstens 100); nur Personen, keine Maschinen-Clients. */
export const defaultPeople: IamPeople = {
  async search(q, signal) {
    const s = new URLSearchParams({ limit: '20' });
    if (q.trim()) s.set('q', q.trim());
    const r = await iamFetch<PersonList>(`/v1/people?${s}`, { signal });
    return r.items.filter(p => p.kind === 'user').map(toPerson);
  },
  async resolve(ids, signal) {
    const out: IamPerson[] = [];
    for (let i = 0; i < ids.length; i += BATCH_MAX) {
      const s = new URLSearchParams();
      for (const id of ids.slice(i, i + BATCH_MAX)) s.append('ids', id);
      out.push(...(await iamFetch<PersonList>(`/v1/people?${s}`, { signal })).items.map(toPerson));
    }
    return out;
  },
};

export const usePeople = (): IamPeople => useIamConfig().people ?? defaultPeople;

type Waiter = { resolve: (p: IamPerson) => void; reject: (e: unknown) => void };
/** Je Adapter ein Sammler: Einzelabfragen innerhalb von 10 ms werden ein Aufruf. */
const batchers = new WeakMap<IamPeople, (id: string) => Promise<IamPerson>>();

function batcher(people: IamPeople): (id: string) => Promise<IamPerson> {
  const known = batchers.get(people);
  if (known) return known;
  let pending = new Map<string, Waiter[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    const batch = pending;
    pending = new Map();
    timer = null;
    const ids = [...batch.keys()];
    try {
      // Eine Antwort für alle Wartenden; Abbruch einer einzelnen Abfrage bricht den gemeinsamen Aufruf nicht ab
      const found = new Map((await people.resolve(ids, new AbortController().signal)).map(p => [p.id.toLowerCase(), p]));
      for (const id of ids) {
        const p = found.get(id);
        for (const w of batch.get(id) ?? []) {
          if (p) w.resolve(p);
          else w.reject(new ApiError(404, { title: t('iam.person.notFound'), status: 404 }));
        }
      }
    } catch (e) {
      for (const ws of batch.values()) for (const w of ws) w.reject(e);
    }
  };
  const load = (id: string) => new Promise<IamPerson>((resolve, reject) => {
    const key = id.toLowerCase();
    pending.set(key, [...(pending.get(key) ?? []), { resolve, reject }]);
    if (pending.size >= BATCH_MAX) { if (timer) clearTimeout(timer); void flush(); }
    else timer ??= setTimeout(() => void flush(), 10);
  });
  batchers.set(people, load);
  return load;
}

/** Eine Person (gesammelt aufgelöst, Zwischenspeicher `['iam', 'people', 'one', id]`). */
export function usePerson(id: string) {
  const people = usePeople();
  return useQuery({ queryKey: iamKeys.person(id), staleTime: 5 * 60_000, retry: false, queryFn: () => batcher(people)(id) });
}

/** Personen suchen; Treffer landen im Zwischenspeicher der Einzelabfragen (keine zweite Abfrage für die Anzeige). */
export async function searchPeople(qc: QueryClient, people: IamPeople, q: string, signal: AbortSignal): Promise<IamPerson[]> {
  const items = await people.search(q, signal);
  for (const p of items) qc.setQueryData(iamKeys.person(p.id), p);
  return items;
}

/** Name einer Person zur Principal-ID; bis zur Antwort die gekürzte ID, unbekannt mit Hinweis. */
export function PersonName({ id }: { id: string }) {
  useIamText();
  const q = usePerson(id);
  const name = q.data?.name ?? (q.error ? t('iam.person.unknown', { id: shortId(id) }) : shortId(id));
  return <span className="iam-person" title={q.data?.email ?? undefined} aria-busy={q.isPending || undefined}>{name}</span>;
}
