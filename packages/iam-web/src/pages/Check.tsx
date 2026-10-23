/**
 * Zugriff › Rechte prüfen: «Wer?» als Segment Ich / Person / Rolle(n) / Maschinen-Client, optional Gruppen und Scopes
 * (Scopes aus dem Katalog). Ergebnis mit dem Baustein RightsOverview (bei Client bzw. gewählten Scopes Rolle ∧ Scope)
 * und daneben die Ressourcen mit Zugriffsregeln samt Entscheid (`GET /v1/acl/effective`, Simulation). Bei einer Person
 * ohne eigene Wahl zeigt die Antwort ihre echten Rechte mit Rollen und Gruppen aus Keycloak (`source: keycloak`); wählt
 * man Rollen oder Gruppen (auch keine), wird simuliert (`simulate`). Ein Maschinen-Client wird als Client geprüft
 * (`client=<Client-ID>`: Scopes begrenzen, Zugriffsregeln für den Client wirken, org-admin ist nicht ausgenommen), ohne
 * eigene Wahl mit Rollen und Scopes des letzten Tokens. Rechte nur über Freigaben einzelner Bereiche stehen unter
 * «Zusätzlich freigegeben». `client` bzw. `rolle` in der URL wählen das «Wer?» vor.
 * Herkunft: vollholz/assets `web/src/features/acl/Check.tsx`.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useClientGrants, useMembers } from '../admin.ts';
import { aclApi, PersonPick, usePermLabel, useResources, type EffectiveQuery } from '../acl/shared.tsx';
import { useAuthz } from '../authz.ts';
import { useIamConfig } from '../config.tsx';
import { relTime } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { MissingRight } from '../rights/MissingRight.tsx';
import { RightsOverview } from '../rights/RightsOverview.tsx';
import { useIam } from '../session.tsx';
import { t, type IamTextKey } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { usePicker } from '../ui/Picker.tsx';
import { ErrorBox, Loading } from '../ui/states.tsx';
import { useAccessSearch } from './Access.tsx';

export type Who = 'me' | 'person' | 'roles' | 'client';
const WHO: Who[] = ['me', 'person', 'roles', 'client'];

/** Eigene Wahl; `null` = Vorschlag (eigene Rollen, Rollen der Person bzw. des letzten Client-Tokens). */
interface Pick { roles: string[] | null; scopes: string[] | null; groups: string }
const FRESH: Pick = { roles: null, scopes: null, groups: '' };

const q = (s: string) => `«${s}»`;
const list = (v: string) => v.split(',').map(x => x.trim()).filter(Boolean);
const toggled = (xs: readonly string[], x: string) => (xs.includes(x) ? xs.filter(y => y !== x) : [...xs, x]);

export function Check() {
  const authz = useAuthz();
  const { me, can } = useIam();
  const { Icon } = useIamUi();
  const { groupRolePrefix = '/orgs' } = useIamConfig();
  useIamText();
  const search = useAccessSearch();
  const urlClient = search.get('client');
  const urlRolle = search.get('rolle');
  // Wahl des «Wer?» in die URL (`client`, `rolle`); andere Angaben bleiben
  const go = (p: { client?: string; rolle?: string }) => search.go({ client: undefined, rolle: undefined, ...p });
  const id = useId();
  const canClients = can('members:admin');
  const [who, setWho] = useState<Who>(urlClient && canClients ? 'client' : urlRolle ? 'roles' : 'me');
  const [person, setPerson] = useState('');
  const [pick, setPick] = useState<Pick>(FRESH);
  // Aufklappen: `null` = automatisch (offen, sobald Gruppen oder Scopes gesetzt sind), sonst die Wahl der Person
  const [moreChoice, setMore] = useState<boolean | null>(null);
  const res = useResources();
  const perm = usePermLabel();
  const members = useMembers(null, canClients && who === 'person' && !!person);
  const clients = useClientGrants(null, canClients);

  const urlRoles = urlRolle ? urlRolle.split(',').filter(Boolean) : [];
  const member = who === 'person' && person ? members.data?.find(m => m.principalId === person) : undefined;
  const grant = who === 'client' ? clients.data?.find(c => c.clientId === urlClient) : undefined;
  const cat = authz.catalog;
  const allRoles = authz.groupRoles(cat?.roles ?? []).flatMap(g => g.roles);

  // Person ohne eigene Wahl: echte Rollen und Gruppen aus Keycloak, sonst Simulation
  const personReal = who === 'person' && pick.roles === null && !list(pick.groups).length;
  const realQuery: EffectiveQuery = { principal: person };
  const real = useQuery({ queryKey: iamKeys.aclEffective(realQuery), enabled: personReal && !!person, placeholderData: keepPreviousData, queryFn: ({ signal }) => aclApi.effective(realQuery, signal) });
  const fromKeycloak = personReal && real.data?.source === 'keycloak';
  // Rollen und Scopes je Blickwinkel: eigene Wahl vor Vorschlag
  const roles = who === 'me' ? me.roles
    : who === 'person' ? pick.roles ?? (fromKeycloak ? real.data!.roles : member?.roles ?? [])
      : who === 'roles' ? pick.roles ?? urlRoles
        : pick.roles ?? grant?.lastRoles ?? [];
  const scopes = who === 'client' ? pick.scopes ?? grant?.lastScopes ?? [] : who === 'person' ? null : pick.scopes;
  const groups = who === 'client' ? [] : list(pick.groups);
  const more = moreChoice ?? (groups.length > 0 || !!scopes?.length);
  const simulated = fromKeycloak ? false : who !== 'me' || groups.length > 0 || scopes !== null;
  // Ohne Person, Rolle bzw. Client gibt es nichts zu prüfen
  const subject = who === 'me' || (who === 'person' ? !!person : who === 'roles' ? roles.length > 0 || groups.length > 0 : !!urlClient);
  // Maschinen-Client: als Client prüfen (Scopes begrenzen, org-admin nicht ausgenommen); ohne eigene Wahl das letzte Token
  const clientReal = who === 'client' && pick.roles === null && pick.scopes === null;
  // Person: zuerst die echten Rechte; nur wenn Keycloak sie nicht liefert, Simulation mit den vorgeschlagenen Rollen
  const query: EffectiveQuery = personReal && (fromKeycloak || !real.data) ? realQuery
    : who === 'client' ? { client: urlClient ?? '', ...(clientReal ? {} : { simulate: true, ...(roles.length ? { roles } : {}), ...(scopes?.length ? { scopes } : {}) }) }
      : !simulated ? {} : {
        ...(who === 'person' ? { principal: person } : {}), simulate: true,
        ...(roles.length ? { roles } : {}), ...(groups.length ? { groups } : {}), ...(scopes?.length ? { scopes } : {}),
      };
  const ask = subject && (!simulated || Object.keys(query).length > 0);
  const eff = useQuery({ queryKey: iamKeys.aclEffective(query), enabled: ask, placeholderData: keepPreviousData, queryFn: ({ signal }) => aclApi.effective(query, signal) });

  const options = WHO.filter(k => k !== 'client' || canClients);
  const choose = (w: Who) => { setWho(w); setPick(FRESH); setPerson(''); setMore(null); go({}); };
  const setRoles = (next: string[]) => { setPick(p => ({ ...p, roles: next })); if (who === 'roles') go({ rolle: next.length ? next.join(',') : undefined }); };
  const onWhoKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = options.indexOf(who);
    const n = e.key === 'ArrowRight' ? (i + 1) % options.length : e.key === 'ArrowLeft' ? (i + options.length - 1) % options.length : -1;
    if (n < 0) return;
    e.preventDefault();
    choose(options[n]!);
    (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
  };

  const whoName = who === 'me' ? me.person.name || t('iam.acl.check.who.me')
    : who === 'person' ? member?.name ?? eff.data?.principal.name ?? t('iam.acl.check.who.person')
      : who === 'client' ? urlClient ?? t('iam.acl.check.who.client')
        : roles.length ? roles.map(r => authz.roleLabel(r)).join(', ') : t('iam.acl.check.rolesWord');
  // Entscheid je Ressource (Rolle oder Freigabe ∧ Zugriffsregeln, vom Server); gewählte Scopes begrenzen zusätzlich
  // (der Server prüft Scopes bei einer Person nicht)
  const scoped = scopes?.length ? new Set((cat?.scopes ?? []).filter(x => scopes.includes(x.key)).flatMap(x => x.permissions as string[])) : null;
  const resources = (eff.data?.resources ?? []).map(r => ({ ...r, allowed: r.allowed && (!scoped || scoped.has(r.permission)) }));
  const granted = (eff.data?.granted ?? []).filter(p => !scoped || scoped.has(p));
  const rulesLink = q(t('iam.acl.check.resources'));

  return (
    <div className="iam-acl-check">
      <form className="iam-card iam-pad iam-acl-who" aria-label={t('iam.acl.tab.check')} onSubmit={e => e.preventDefault()}>
        <div className="iam-acl-who-row">
          <span id={`${id}-who`} className="iam-flbl">{t('iam.acl.check.who')}</span>
          <div className="iam-seg iam-wrap" role="group" aria-labelledby={`${id}-who`}>
            {options.map(k => (
              <button key={k} type="button" aria-pressed={who === k} tabIndex={who === k ? 0 : -1} onClick={() => choose(k)} onKeyDown={onWhoKey}>{t(`iam.acl.check.who.${k}` as IamTextKey)}</button>
            ))}
          </div>
        </div>

        {who === 'me' ? (
          <p className="iam-muted iam-small iam-acl-who-line">{roles.length ? t('iam.acl.check.myRoles', { roles: roles.map(r => q(authz.roleLabel(r))).join(', ') }) : t('iam.acl.check.noRole')} {t('iam.acl.check.real')}</p>
        ) : null}

        {who === 'person' ? (
          <>
            <div className="iam-acl-who-field"><label htmlFor={`${id}-person`} className="iam-flbl">{t('iam.acl.check.who.person')}</label>
              <PersonPick id={`${id}-person`} value={person} onChange={p => { setPerson(p); setPick(FRESH); }} describedBy={`${id}-person-h`} /></div>
            <p id={`${id}-person-h`} className="iam-muted iam-small iam-acl-who-line">
              {t(fromKeycloak ? 'iam.acl.check.person.keycloak' : pick.roles !== null || groups.length ? 'iam.acl.check.person.chosen' : member ? 'iam.acl.check.person.members' : 'iam.acl.check.person.unknown')}
            </p>
            {person ? <RoleToggles label={t('iam.acl.check.personRoles')} roles={allRoles} value={roles} onChange={setRoles} /> : null}
          </>
        ) : null}

        {who === 'roles' ? <RoleToggles label={t('iam.acl.check.roles')} roles={allRoles} value={roles} onChange={setRoles} /> : null}

        {who === 'client' ? (
          <>
            <div className="iam-acl-who-field"><label htmlFor={`${id}-client`} className="iam-flbl">{t('iam.acl.check.who.client')}</label>
              <select id={`${id}-client`} className="iam-inp" value={urlClient ?? ''} onChange={e => { setPick(FRESH); go({ client: e.target.value || undefined }); }}>
                <option value="">{t('iam.acl.check.chooseClient')}</option>
                {urlClient && clients.data && !grant ? <option value={urlClient}>{t('iam.acl.check.notGranted', { id: urlClient })}</option> : null}
                {(clients.data ?? []).map(c => <option key={c.clientId} value={c.clientId}>{c.clientId}{c.description ? ` – ${c.description}` : ''}</option>)}
              </select></div>
            {clients.error ? <ErrorBox error={clients.error} compact /> : null}
            {urlClient && clients.data && !grant ? <p className="iam-muted iam-small iam-acl-who-line">{t('iam.acl.check.notGrantedText')}</p> : null}
            {grant ? <p className="iam-muted iam-small iam-acl-who-line">{grant.lastUsedAt ? t('iam.acl.check.lastToken', { when: relTime(grant.lastUsedAt) }) : t('iam.acl.check.neverUsed')}</p> : null}
            {urlClient ? (
              <>
                <RoleToggles label={t('iam.acl.check.tokenRoles')} roles={allRoles} value={roles} onChange={setRoles} />
                <ScopePick value={scopes ?? []} onChange={s => setPick(p => ({ ...p, scopes: s }))} />
              </>
            ) : null}
          </>
        ) : null}

        {who !== 'client' ? (
          <>
            <button type="button" className="iam-linkbtn iam-acl-more" aria-expanded={more} aria-controls={`${id}-more`} onClick={() => setMore(!more)}>
              <Icon name="chev" className="iam-ico" />{t(who !== 'person' ? 'iam.acl.check.more' : 'iam.acl.check.moreGroups')}{!more && (groups.length || scopes?.length) ? <span className="iam-muted"> · {t('iam.acl.check.chosen', { n: [...groups, ...(scopes ?? [])].length })}</span> : null}
            </button>
            <div id={`${id}-more`} className="iam-acl-more-b" hidden={!more}>
              <label className="iam-lblcol">{t('iam.acl.check.groups')}
                <input className="iam-inp" value={pick.groups} onChange={e => setPick(p => ({ ...p, groups: e.target.value }))} placeholder={`${groupRolePrefix.replace(/\/+$/, '')}/${me.tenant?.alias ?? '<alias>'}/team`} autoComplete="off" /></label>
              {who !== 'person' ? <ScopePick value={scopes ?? []} optional onChange={s => setPick(p => ({ ...p, scopes: s.length ? s : null }))} /> : null}
            </div>
          </>
        ) : null}
      </form>

      {!canClients && urlClient ? <MissingRight perm="members:admin" lead={t('iam.acl.check.missingClients')} /> : null}

      {!subject ? (
        <p className="iam-muted iam-acl-hint">{t(who === 'person' ? 'iam.acl.check.pickPerson' : who === 'client' ? 'iam.acl.check.pickClient' : 'iam.acl.check.pickRole')}</p>
      ) : (
        <div className="iam-acl-res">
          <section className="iam-card iam-pad iam-acl-res-main" aria-labelledby={`${id}-res`}>
            <div className="iam-card-h"><h2 id={`${id}-res`}>{t('iam.acl.check.rightsOf', { name: whoName })}</h2>{eff.data?.simulated ?? simulated ? <span className="iam-mk iam-info">{t('iam.acl.check.simulated')}</span> : null}</div>
            <RightsOverview roles={roles} scopes={scopes ?? undefined} headingLevel={3} rulesNote={t('iam.acl.check.rulesNote', { where: rulesLink })}
              {...(who === 'me' && !simulated ? { permissions: me.permissions } : {})} />
            {granted.length ? (
              <div className="iam-acl-granted">
                <h3>{t('iam.acl.check.granted')}</h3>
                <p className="iam-muted iam-small">{t('iam.acl.check.grantedText', { perms: granted.map(p => q(perm(p))).join(', '), where: rulesLink })}</p>
              </div>
            ) : null}
          </section>
          <section className="iam-card iam-pad iam-acl-res-side" aria-labelledby={`${id}-rr`}>
            <div className="iam-card-h"><h2 id={`${id}-rr`}>{t('iam.acl.check.resources')}</h2>{eff.data ? <span className="iam-cnt">{resources.length}</span> : null}</div>
            {!ask ? <p className="iam-muted iam-small">{t('iam.acl.check.noRoleNoRights')}</p>
              : eff.isPending ? <Loading inline /> : eff.error ? <ErrorBox error={eff.error} compact /> : resources.length ? (
                <ul className="iam-acl-rl" aria-label={t('iam.acl.check.decisions')}>
                  {resources.map(r => (
                    <li key={`${r.resourceType}-${r.resourceId}-${r.permission}`} className={r.allowed ? 'iam-is-ok' : 'iam-is-bad'}>
                      <Icon name={r.allowed ? 'check' : 'x'} className="iam-ico" />
                      <span className="iam-acl-rl-t"><span title={r.permission}>{perm(r.permission)}</span> <span className="iam-muted">· {authz.resourceLabel(r.resourceType)} {res.name(r.resourceType, r.resourceId)}</span></span>
                      <span className="iam-acl-rl-s">{t(r.allowed ? 'iam.acl.check.allowed' : 'iam.acl.check.denied')}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="iam-muted iam-small">{t('iam.acl.check.noResources')}</p>}
          </section>
        </div>
      )}
    </div>
  );
}

/** Rollen als Umschalter (eine Zeile, umbrechend); Kurzbeschreibung als title. */
function RoleToggles({ label, roles, value, onChange }: { label: string; roles: { key: string; label: string; description: string }[]; value: readonly string[]; onChange: (v: string[]) => void }) {
  const id = useId();
  return (
    <div className="iam-acl-who-field">
      <span id={id} className="iam-flbl">{label}</span>
      <div className="iam-seg iam-xs iam-wrap iam-acl-roles" role="group" aria-labelledby={id}>
        {roles.map(r => <button key={r.key} type="button" aria-pressed={value.includes(r.key)} title={r.description} onClick={() => onChange(toggled(value, r.key))}>{r.label}</button>)}
      </div>
    </div>
  );
}

/** Scopes (Freigabe im Token) aus dem Katalog wählen; gewählte als Pillen mit Text im title. */
function ScopePick({ value, onChange, optional }: { value: readonly string[]; onChange: (v: string[]) => void; optional?: boolean }) {
  const authz = useAuthz();
  const { Button, Icon } = useIamUi();
  const picker = usePicker();
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = () => btn.current && picker.open({
    anchor: btn.current, title: t('iam.acl.check.pickScopes'), placeholder: t('iam.acl.check.searchScope'), multi: true, selected: [...value],
    items: (authz.catalog?.scopes ?? []).map(s => ({ value: s.key, label: s.key, sub: s.text, icon: 'key' as const })),
    onPick: v => onChange(v),
  });
  return (
    <div className="iam-acl-who-field">
      <span id={id} className="iam-flbl">{t('iam.acl.check.scopes')} <span className="iam-muted">({t(optional ? 'iam.acl.check.scopesOptional' : 'iam.acl.check.scopesHint')})</span></span>
      <div className="iam-acl-scopes" role="group" aria-labelledby={id}>
        {value.map(s => (
          <span key={s} className="iam-pill iam-sm" title={authz.scopeText(s) || undefined}>{s}
            <button type="button" className="iam-acl-x" aria-label={t('iam.acl.check.removeScope', { scope: s })} onClick={() => onChange(value.filter(x => x !== s))}><Icon name="x" className="iam-ico" /></button></span>
        ))}
        {!value.length && !optional ? <span className="iam-muted iam-small">{t('iam.acl.check.noScope')}</span> : null}
        <Button ref={btn} size="sm" variant="ghost" icon="plus" aria-haspopup="dialog" onClick={open}>{t(value.length ? 'iam.acl.check.changeScopes' : 'iam.acl.check.pickScopes')}</Button>
      </div>
      {picker.node}
    </div>
  );
}
