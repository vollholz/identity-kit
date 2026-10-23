/**
 * Gemeinsames der Zugriffsregeln: Daten (`/v1/acl`), Namen der Ressourcen über den Adapter `resources`, Anzeige von
 * Principals und die Personenauswahl. Herkunft: vollholz/assets `web/src/features/acl/shared.tsx`, produktneutral.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useAuthz } from '../authz.ts';
import { iamFetch } from '../client.ts';
import { useIamConfig } from '../config.tsx';
import type { AclEntry, AclInput, AclList, Effective } from '../contract.ts';
import { shortId } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { isPrincipalId, PersonName, searchPeople, usePeople, type IamPerson } from '../people.tsx';
import type { Permission } from '../permissions.ts';
import { t, type IamTextKey } from '../texts/index.ts';
import { useIamUi } from '../ui/context.tsx';
import { usePicker } from '../ui/Picker.tsx';
import { grantBlockedTypes, leafKnown, noGrantTypes, type AclLike } from './rules.ts';

/** Abfrage für `GET /v1/acl/effective` (Spezifikation 7.1): echte Rechte oder Simulation. */
export interface EffectiveQuery { principal?: string; client?: string; simulate?: boolean; roles?: string[]; groups?: string[]; scopes?: string[] }

const effectiveSearch = (q: EffectiveQuery) => {
  const s = new URLSearchParams();
  if (q.principal) s.set('principal', q.principal);
  if (q.client !== undefined) s.set('client', q.client);
  if (q.simulate) s.set('simulate', 'true');
  for (const k of ['roles', 'groups', 'scopes'] as const) for (const v of q[k] ?? []) s.append(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const aclApi = {
  list: (signal?: AbortSignal) => iamFetch<AclList>('/v1/acl', { signal }).then(r => r.items),
  create: (body: AclInput) => iamFetch<AclEntry>('/v1/acl', { method: 'POST', body }),
  remove: (id: string) => iamFetch<void>(`/v1/acl/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  effective: (q: EffectiveQuery, signal?: AbortSignal) => iamFetch<Effective>(`/v1/acl/effective${effectiveSearch(q)}`, { signal }),
};

/** Alle Zugriffsregeln der Organisation (`acl:read`); `enabled: false` ohne Recht, damit kein 403 entsteht. */
export function useAclEntries(enabled = true) {
  return useQuery({ queryKey: iamKeys.acl, enabled, staleTime: 60_000, retry: false, queryFn: ({ signal }) => aclApi.list(signal) });
}

/** Einmal je Seite: Blatt der Kette unbekannt (weder `resources.noGrant` noch `leaf` im Katalog). */
let warnedLeaf = false;

/** Namen, Bekanntheit und Blätter der Ressourcen; ohne Adapter die ID und «nicht prüfbar». */
export function useResources() {
  const { resources } = useIamConfig();
  const authz = useAuthz();
  const r = resources?.useResolver();
  const leafSure = leafKnown(authz.catalog, resources?.noGrant);
  if (authz.catalog && !leafSure && !warnedLeaf) {
    warnedLeaf = true;
    console.warn('@vollholz/iam-web: Blatt der Ressourcenkette unbekannt – der Katalog meldet kein `leaf` und `resources.noGrant` fehlt. «Freigeben» ist nur auf der ganzen Organisation möglich.');
  }
  return {
    name: (type: string, id: string | null) => (!id ? (type === 'tenant' ? t('iam.acl.tenantName') : '—') : r?.name(type, id) ?? id),
    /** `false`: geladen und unbekannt (gelöscht, nicht sichtbar oder aus einer anderen Organisation); `undefined`: nicht prüfbar. */
    known: (type: string, id: string | null): boolean | undefined => (!id ? true : r?.known(type, id)),
    /** Blätter, soweit bekannt (für «wirkungslos»). */
    leaves: noGrantTypes(authz.catalog, resources?.noGrant),
    /** Typen ohne «Freigeben» im Dialog; ohne bekanntes Blatt alle ausser der Organisation. */
    noGrant: grantBlockedTypes(authz.catalog, resources?.noGrant),
    leafKnown: leafSure,
  };
}

const PRINC_KEYS = ['user', 'group', 'role', 'client'] as const;
export const principalTypes = () => PRINC_KEYS.map(k => [k, t(`iam.acl.principal.${k}` as IamTextKey)] as const);
export const principalLabel = (type: string) => (PRINC_KEYS.includes(type as never) ? t(`iam.acl.principal.${type}` as IamTextKey) : type);

/** Wer ein Eintrag betrifft: Rolle mit Label (Schlüssel als Zusatz), Person mit Namen, Gruppe und Client als Referenz. */
export function PrincipalLabel({ e }: { e: Pick<AclLike, 'principalType' | 'principalRef'> }) {
  const authz = useAuthz();
  if (e.principalType === 'role') return <>{authz.roleLabel(e.principalRef)} <span className="iam-mono-s iam-muted">{e.principalRef}</span></>;
  // Person über die Principal-ID mit Namen; über ihr Subject (auch erlaubt) wie angegeben
  if (e.principalType === 'user' && isPrincipalId(e.principalRef)) return <PersonName id={e.principalRef} />;
  return <span className="iam-mono-s">{e.principalRef}</span>;
}

/** Principal als Satzteil («Personen mit Rolle «Bearbeiter:in»»); Personennamen aus dem Zwischenspeicher des Verzeichnisses. */
export function useWhoText() {
  const authz = useAuthz();
  const qc = useQueryClient();
  return (e: Pick<AclLike, 'principalType' | 'principalRef'>) => {
    if (e.principalType === 'role') return t('iam.acl.who.role', { role: authz.roleLabel(e.principalRef) });
    if (e.principalType === 'group') return t('iam.acl.who.group', { group: e.principalRef });
    if (e.principalType === 'client') return t('iam.acl.who.client', { client: e.principalRef });
    const p = qc.getQueryData<IamPerson>(iamKeys.person(e.principalRef));
    return p ? t('iam.acl.who.person', { name: p.name }) : t('iam.acl.who.personId', { id: isPrincipalId(e.principalRef) ? shortId(e.principalRef) : e.principalRef });
  };
}

/** Recht als Label (Schlüssel, solange der Katalog lädt). */
export const usePermLabel = () => { const authz = useAuthz(); return (p: string) => authz.permLabel(p as Permission); };

/** Auswahl einer Person über die Suche im Personenverzeichnis (Name, E-Mail); Wert ist die Principal-ID. */
export function PersonPick({ id, value, onChange, describedBy, invalid }: { id: string; value: string; onChange: (id: string) => void; describedBy?: string; invalid?: boolean }) {
  const qc = useQueryClient();
  const people = usePeople();
  const btn = useRef<HTMLButtonElement>(null);
  const picker = usePicker();
  const open = () => btn.current && picker.open({
    anchor: btn.current, title: t('iam.acl.pickPerson'), placeholder: t('iam.acl.pickPersonHint'), selected: value ? [value] : [], allowClear: true,
    load: async q => (await searchPeople(qc, people, q, new AbortController().signal)).map(p => ({ value: p.id, label: p.name, sub: p.email ?? undefined, icon: 'user' as const })),
    onPick: ([v]) => onChange(v ?? ''),
  });
  return (
    <>
      <button id={id} ref={btn} type="button" className="iam-inp iam-pickbtn" aria-haspopup="dialog" aria-describedby={describedBy} aria-invalid={invalid || undefined} onClick={open}>
        {value ? <PersonName id={value} /> : <span className="iam-ph">{t('iam.acl.searchPerson')}</span>}
      </button>
      {picker.node}
    </>
  );
}

/** Auswahl einer Ressource über den Adapter (`resources.pick`); ohne Adapter Eingabe der ID. */
export function ResourcePick({ id, type, value, onChange, describedBy, invalid }: { id: string; type: string; value: string; onChange: (id: string) => void; describedBy?: string; invalid?: boolean }) {
  const { resources } = useIamConfig();
  const authz = useAuthz();
  const res = useResources();
  const { Icon } = useIamUi();
  const btn = useRef<HTMLButtonElement>(null);
  const picker = usePicker();
  if (!resources) {
    return <input id={id} className="iam-inp iam-mono-s" value={value} onChange={e => onChange(e.target.value.trim())} autoComplete="off" placeholder={t('iam.acl.resourceId')}
      aria-invalid={invalid || undefined} aria-describedby={describedBy} />;
  }
  const label = authz.resourceLabel(type);
  const open = () => btn.current && picker.open({
    anchor: btn.current, title: t('iam.acl.pickResource', { type: label }), selected: value ? [value] : [],
    load: async q => (await resources.pick(type, q, new AbortController().signal)).map(o => ({ value: o.value, label: o.label, sub: o.sub })),
    onPick: ([v]) => onChange(v ?? ''),
  });
  return (
    <>
      <button id={id} ref={btn} type="button" className="iam-inp iam-pickbtn" aria-haspopup="dialog" aria-describedby={describedBy} aria-invalid={invalid || undefined} onClick={open}>
        {value ? res.name(type, value) : <span className="iam-ph">{t('iam.acl.chooseResource', { type: label })}</span>}
        <Icon name="chev" className="iam-ico" />
      </button>
      {picker.node}
    </>
  );
}
