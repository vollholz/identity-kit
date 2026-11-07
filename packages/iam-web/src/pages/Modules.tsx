/**
 * Einstellungen › Module (Konzept «Module je Organisation», Abschnitt 8): Produktmodule der Organisation sehen
 * (`tenant:read`) und aktivieren bzw. deaktivieren (`tenant:admin`). Liste mit Schublade: je Modul Name,
 * Kurzbeschreibung, Status (Aktiv · Aus · Nicht freigegeben), Voraussetzungen als Text und Schalter; Teilfunktionen
 * darunter. Jede Zeile (Modul und Teilfunktion) ist dasselbe Raster: Text · Status · Schalter; Status und Schalter
 * stehen in allen Zeilen in derselben Spalte, eingerückt wird nur der Text der Teilfunktionen. Der Name öffnet die
 * Schublade mit Einzelheiten (Rechte, Teilfunktionen, gebraucht von, Hindernisse). Eigene Modulseite einer App:
 * dieselben Hilfen aus `@vollholz/iam-web/pages` (docs/module-je-organisation.md, Abschnitt 8).
 *
 * - Aktivieren: Hinweis auf mitzuaktivierende Voraussetzungen («Aktiviert auch …»), bei «eines von» mit Wahl.
 * - Deaktivieren: Rückfrage mit der Wirkung (Arbeitsflächen und Rechte verschwinden für alle, Daten bleiben) und den
 *   Hindernissen der App bzw. den Modulen, die es noch brauchen – dann ohne Deaktivieren.
 * - Gesperrt (Pflichtmodul, nicht freigegeben, fehlendes Recht, Voraussetzung): Schalter sichtbar, per `aria-disabled`
 *   gesperrt, fokussierbar, Grund sichtbar und in `aria-describedby`. Pflichtmodule sehen aus wie alle anderen: Status
 *   «Aktiv», Schalter eingeschaltet und gesperrt («Pflichtmodul – immer aktiv»).
 *
 * Plattform-Administration: `ModulesSection` in der Detailseite einer Organisation (freigeben, entziehen, Hindernisse mit
 * «Trotzdem entziehen» übergehen).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { useAuthz, useAuthzCatalog } from '../authz.ts';
import type { ModuleBlocker, TenantModule } from '../contract.ts';
import { fmtDate } from '../format.ts';
import {
  activationPlan, choiceKey, dependentsOf, moduleApi, moduleErrorText, moduleIsOn, moduleLabel, moduleLockReason, moduleRights, partsOf, requiresText, useModules, usedBy,
  type ModuleChoice, type ModuleListResult,
} from '../moduleTools.ts';
import { modulesChanged, useModulesFeature } from '../modules.ts';
import { AdminHead } from '../rights/AdminHead.tsx';
import { useIam } from '../session.tsx';
import { listAnd, t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { Sheet } from '../ui/Overlay.tsx';
import { Empty, ErrorBox, ErrorState, SkeletonRows } from '../ui/states.tsx';

const quote = (s: string) => t('iam.modules.quoted', { name: s });
const names = (items: readonly TenantModule[], keys: readonly string[]) => listAnd(keys.map(k => quote(moduleLabel(items, k))));

type Status = 'active' | 'off' | 'notAllowed';
/** Pflichtmodule zeigen denselben Status wie aktive Module («Aktiv»); die Sperre erklärt der Schalter. */
const statusOf = (m: TenantModule): Status => (m.core || (m.allowed && m.active) ? 'active' : !m.allowed ? 'notAllowed' : 'off');
const STATUS_CLASS: Record<Status, string> = { active: 'iam-st-ok', off: 'iam-st-idle', notAllowed: 'iam-st-off' };
const STATUS_TEXT = { active: 'iam.modules.status.active', off: 'iam.modules.status.off', notAllowed: 'iam.modules.status.notAllowed' } as const;

function StatusPill({ m }: { m: TenantModule }) {
  const s = statusOf(m);
  return <span className={`iam-pill iam-sm ${STATUS_CLASS[s]}`}>{t(STATUS_TEXT[s])}</span>;
}

/** Was gerade geschaltet werden soll (Rückfrage vor dem Aktivieren mit Voraussetzungen bzw. vor dem Deaktivieren). */
type Pending = { key: string; active: boolean };

/**
 * Schalter «Aktiv» (role=switch): gesperrt per `aria-disabled` mit Grund in `aria-describedby`, bleibt fokussierbar.
 * Pflichtmodule: eingeschaltet und gesperrt.
 */
function ModuleSwitch({ m, locked, describedBy, busy, onToggle }: { m: TenantModule; locked: boolean; describedBy?: string; busy?: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="switch" className="iam-switch iam-mod-switch" aria-checked={moduleIsOn(m)} aria-disabled={locked || busy ? true : undefined}
      aria-label={t('iam.modules.switch', { name: m.label })} aria-describedby={describedBy} onClick={() => { if (!locked && !busy) onToggle(); }}>
      <span aria-hidden="true" />
    </button>
  );
}

/** Seite «Module» der eigenen Organisation. */
export function ModulesPage() {
  const iam = useIam();
  const authz = useAuthz();
  useIamText();
  const feature = useModulesFeature();
  const cat = useAuthzCatalog();
  const admin = iam.can('tenant:admin');
  const q = useModules(null, feature === true);
  const [sheet, setSheet] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const flow = useSwitchFlow(q.data);
  const toggle = (m: TenantModule) => {
    const items = q.data?.items ?? [];
    const next = !m.active;
    // Ohne Rückfrage: Teilfunktion bzw. Modul ohne mitzuaktivierende Voraussetzungen einschalten
    const plan = next && !m.module ? activationPlan(items, m.key) : null;
    if (next && (!plan || (!plan.also.length && !plan.choices.length))) flow.run({ key: m.key, active: true }, {});
    else setPending({ key: m.key, active: next });
  };
  const list = q.data?.items ?? [];
  const modules = list.filter(m => !m.module);
  return (
    <>
      <AdminHead icon="layers" title={t('iam.modules.title')} sub={t('iam.modules.sub', { org: iam.orgName })} />
      <div className="iam-body"><div className="iam-int">
        {feature === undefined && cat.error ? <ErrorState error={cat.error} onRetry={() => void cat.refetch()} />
          : feature === undefined || (feature && q.isPending) ? <SkeletonRows rows={4} cols={3} />
          : !feature ? <Empty icon="layers" title={t('iam.modules.none')}>{t('iam.modules.noneText')}</Empty>
          : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          : (
            <>
              {!admin ? <p className="iam-note" role="note">{t('iam.modules.readOnly', { perm: authz.permLabel('tenant:admin') })}</p> : null}
              {flow.error && !pending ? <ModuleError error={flow.error} items={list} moduleKey={flow.errorKey!} onRetry={() => void q.refetch()} /> : null}
              <ul className="iam-mod-list" aria-label={t('iam.modules.title')}>
                {modules.map(m => (
                  <li key={m.key} className="iam-mod">
                    <ModuleRow m={m} items={list} admin={admin} busy={flow.busy === m.key} onToggle={() => toggle(m)} onOpen={() => setSheet(m.key)} />
                    {partsOf(list, m.key).length ? (
                      <ul className="iam-mod-parts" aria-label={t('iam.modules.partsOf', { name: m.label })}>
                        {partsOf(list, m.key).map(p => (
                          <li key={p.key}><ModuleRow m={p} items={list} admin={admin} busy={flow.busy === p.key} onToggle={() => toggle(p)} /></li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
      </div></div>
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code tabIndex={0}>GET /v1/tenant/modules · PUT /v1/tenant/modules/{'{key}'}</code></div>
      {sheet && q.data ? <ModuleSheet data={q.data} moduleKey={sheet} admin={admin} onClose={() => setSheet(null)} onToggle={m => toggle(m)} /> : null}
      {pending && q.data ? (
        <SwitchDialog data={q.data} pending={pending} flow={flow} onClose={() => { flow.reset(); setPending(null); }} onDone={() => setPending(null)} />
      ) : null}
    </>
  );
}

/**
 * Zeile eines Moduls bzw. einer Teilfunktion, ein Raster mit festen Spalten (styles.css «Module»): Name · Status ·
 * Schalter, darunter in der Textspalte Beschreibung, Voraussetzungen und Sperrgrund. Teilfunktionen rücken nur den Text
 * ein; Status und Schalter bleiben in derselben Spalte wie die der Module.
 */
function ModuleRow({ m, items, admin, busy, onToggle, onOpen }: { m: TenantModule; items: readonly TenantModule[]; admin: boolean; busy: boolean; onToggle: () => void; onOpen?: () => void }) {
  const fid = useId();
  const authz = useAuthz();
  const reason = moduleLockReason(items, m, admin, authz.permLabel('tenant:admin'));
  const req = requiresText(items, m);
  return (
    <div className={`iam-mod-row${m.module ? ' iam-mod-part' : ''}`}>
      <div className="iam-mod-name">
        {onOpen ? <button type="button" className="iam-linkbtn" aria-haspopup="dialog" onClick={onOpen}>{m.label}</button> : <span>{m.label}</span>}
      </div>
      <div className="iam-mod-status"><StatusPill m={m} /></div>
      <ModuleSwitch m={m} locked={!!reason} busy={busy} describedBy={reason ? `${fid}-why` : undefined} onToggle={onToggle} />
      {m.description || req || reason ? (
        <div className="iam-mod-info">
          {m.description ? <div className="iam-muted">{m.description}</div> : null}
          {req ? <div>{req}</div> : null}
          {reason ? <div id={`${fid}-why`} className="iam-mod-why">{reason}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Schalten

/**
 * Schalten mit Voraussetzungen: zuerst die mitzuaktivierenden Module, dann das gewählte, je mit `If-Match` der zuletzt
 * bekannten Version. Danach Liste und Sitzung (`modules`, Rechte) neu laden.
 */
function useSwitchFlow(data: ModuleListResult | undefined) {
  const qc = useQueryClient();
  const { toast } = useIamUi();
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: async ({ p, choice }: { p: Pending; choice: ModuleChoice }) => {
      setErrorKey(p.key);
      setBusy(p.key);
      const items = data?.items ?? [];
      const keys = p.active && !items.find(x => x.key === p.key)?.module ? [...activationPlan(items, p.key, choice).also, p.key] : [p.key];
      let etag = data?.etag ?? null;
      for (const k of keys) {
        setErrorKey(k);
        etag = (await moduleApi(null).setActive(k, p.active, etag)).etag;
      }
      return { p, items, keys };
    },
    onSuccess: ({ p, items, keys }) => {
      const label = quote(moduleLabel(items, p.key));
      toast.show(p.active ? (keys.length > 1 ? t('iam.modules.activatedWith', { name: label, list: names(items, keys.slice(0, -1)) }) : t('iam.modules.activated', { name: label })) : t('iam.modules.deactivated', { name: label }));
    },
    onSettled: async (_d, e) => {
      setBusy(null);
      await modulesChanged(qc, null);
      if (!e) setErrorKey(null);
    },
  });
  return {
    run: (p: Pending, choice: ModuleChoice, onDone?: () => void) => m.mutate({ p, choice }, { onSuccess: () => onDone?.() }),
    reset: () => { m.reset(); setErrorKey(null); },
    error: m.error, errorKey, busy, pending: m.isPending,
  };
}

type SwitchFlow = ReturnType<typeof useSwitchFlow>;

/** Fehler des Servers beim Schalten, mit Hindernissen als Liste; 412: Hinweis und neu laden. */
function ModuleError({ error, items, moduleKey, onRetry }: { error: unknown; items: readonly TenantModule[]; moduleKey: string; onRetry?: () => void }) {
  const { Icon, Button } = useIamUi();
  const text = moduleErrorText(error, items, moduleKey);
  if (!text) return <ErrorBox error={error} compact />;
  return (
    <div className="iam-errbox iam-compact" role="alert">
      <Icon name="warn" className="iam-ico" />
      <div className="iam-grow">
        <b>{text.title}</b>
        {text.blockers?.length ? <Blockers blockers={text.blockers} /> : null}
      </div>
      {text.stale && onRetry ? <Button size="sm" onClick={onRetry}>{t('iam.modules.reload')}</Button> : null}
    </div>
  );
}

function Blockers({ blockers }: { blockers: readonly ModuleBlocker[] }) {
  return <ul className="iam-mod-blockers">{blockers.map(b => <li key={b.key}>{b.text}</li>)}</ul>;
}

/** Wirkung des Deaktivieren bzw. Entziehens: Teilfunktionen und Rechte verschwinden für alle, Daten bleiben. */
function Effect({ items, m, org }: { items: readonly TenantModule[]; m: TenantModule; org: string }) {
  const authz = useAuthz();
  const parts = partsOf(items, m.key).filter(p => p.active).map(p => p.key);
  const rights = moduleRights(authz.catalog, m.key);
  return (
    <>
      <p>{t('iam.modules.effect', { name: quote(m.label), org })}</p>
      <ul className="iam-mod-effect">
        {parts.length ? <li>{t('iam.modules.effectParts', { list: names(items, parts) })}</li> : null}
        {rights.length ? <li>{t('iam.modules.effectRights', { list: listAnd(rights) })}</li> : null}
        <li>{t('iam.modules.effectData')}</li>
      </ul>
    </>
  );
}

/** Rückfrage vor dem Schalten: Aktivieren mit Voraussetzungen (und Wahl «eines von») bzw. Deaktivieren mit Wirkung. */
function SwitchDialog({ data, pending, flow, onClose, onDone }: { data: ModuleListResult; pending: Pending; flow: SwitchFlow; onClose: () => void; onDone: () => void }) {
  const { Dialog, Button } = useIamUi();
  const { orgName } = useIam();
  const fid = useId();
  const items = data.items;
  const m = items.find(x => x.key === pending.key)!;
  const [choice, setChoice] = useState<ModuleChoice>({});
  const name = quote(m.label);
  const footer = (ok: ReactNode | null) => <><Button variant="ghost" data-cancel onClick={onClose}>{ok ? t('iam.common.cancel') : t('iam.common.close')}</Button>{ok}</>;
  if (pending.active) {
    const plan = activationPlan(items, m.key, choice);
    return (
      <Dialog title={t('iam.modules.activateTitle', { name: m.label })} role="alertdialog" width={480} onClose={onClose} initialFocus="[data-confirm]"
        footer={footer(<Button variant="primary" data-confirm busy={flow.pending} onClick={() => flow.run(pending, choice, onDone)}>{plan.also.length ? t('iam.modules.activateAll', { n: plan.also.length + 1 }) : t('iam.modules.activate')}</Button>)}>
        {plan.also.length ? <p>{t('iam.modules.alsoActivates', { list: names(items, plan.also) })}</p> : null}
        {plan.choices.map(c => (
          <fieldset key={choiceKey(c.alts)} className="iam-fs">
            <legend>{t('iam.modules.chooseOne', { name })}</legend>
            {c.alts.map(a => (
              <label key={a} className="iam-chk" htmlFor={`${fid}-${a}`}>
                <input id={`${fid}-${a}`} type="radio" name={`${fid}-${choiceKey(c.alts)}`} checked={c.chosen === a} onChange={() => setChoice({ ...choice, [choiceKey(c.alts)]: a })} />
                {' '}{moduleLabel(items, a)}
              </label>
            ))}
          </fieldset>
        ))}
        <p className="iam-muted iam-small">{t('iam.modules.activateText', { org: orgName })}</p>
        {flow.error ? <ModuleError error={flow.error} items={items} moduleKey={flow.errorKey ?? m.key} /> : null}
      </Dialog>
    );
  }
  const deps = m.module ? [] : dependentsOf(items, m.key);
  const known = m.blockers ?? [];
  const serverErr = flow.error ? moduleErrorText(flow.error, items, m.key) : null;
  const blockers = serverErr?.blockers?.length ? serverErr.blockers : known;
  const stuck = deps.length > 0 || blockers.length > 0;
  return (
    <Dialog title={t('iam.modules.deactivateTitle', { name: m.label })} role="alertdialog" width={480} onClose={onClose} initialFocus="[data-cancel]"
      footer={footer(stuck ? null : <Button variant="danger-solid" data-confirm busy={flow.pending} onClick={() => flow.run(pending, {}, onDone)}>{t('iam.modules.deactivate')}</Button>)}>
      <Effect items={items} m={m} org={orgName} />
      {deps.length ? <div className="iam-mod-stop" role="note"><b>{t('iam.modules.neededBy', { list: names(items, deps) })}</b></div> : null}
      {blockers.length ? (
        <div className="iam-mod-stop" role="note"><b>{t('iam.modules.blockersTitle')}</b><Blockers blockers={blockers} /></div>
      ) : null}
      {flow.error && !serverErr?.blockers ? <ModuleError error={flow.error} items={items} moduleKey={flow.errorKey ?? m.key} /> : null}
    </Dialog>
  );
}

/** Schublade eines Moduls: Beschreibung, Status, Voraussetzungen, gebraucht von, Teilfunktionen, Rechte, Hindernisse. */
function ModuleSheet({ data, moduleKey, admin, onClose, onToggle }: { data: ModuleListResult; moduleKey: string; admin: boolean; onClose: () => void; onToggle: (m: TenantModule) => void }) {
  const { Button } = useIamUi();
  const authz = useAuthz();
  const fid = useId();
  const items = data.items;
  const m = items.find(x => x.key === moduleKey);
  if (!m) return null;
  const reason = moduleLockReason(items, m, admin, authz.permLabel('tenant:admin'));
  const on = moduleIsOn(m);
  const parts = partsOf(items, m.key);
  const by = usedBy(items, m.key);
  const rights = moduleRights(authz.catalog, m.key);
  const req = requiresText(items, m);
  return (
    <Sheet title={m.label} sub={<div className="iam-mod-sheet-sub"><StatusPill m={m} />{m.activeSince && m.active && !m.core ? <span className="iam-muted iam-small">{t('iam.modules.since', { date: fmtDate(m.activeSince) })}</span> : null}</div>} onClose={onClose} narrow
      footer={(
        <>
          {reason ? <div id={`${fid}-why`} className="iam-mod-why iam-grow">{reason}</div> : <span className="iam-grow" />}
          <Button variant={on ? 'danger' : 'primary'} aria-disabled={reason ? true : undefined} aria-describedby={reason ? `${fid}-why` : undefined}
            onClick={() => { if (!reason) onToggle(m); }}>{on ? t('iam.modules.deactivate') : t('iam.modules.activate')}</Button>
        </>
      )}>
      {m.description ? <p>{m.description}</p> : null}
      <dl className="iam-kv">
        <dt>{t('iam.modules.col.requires')}</dt><dd>{req ?? t('iam.modules.requiresNone')}</dd>
        {by.length ? <><dt>{t('iam.modules.col.usedBy')}</dt><dd>{names(items, by)}</dd></> : null}
        {parts.length ? <><dt>{t('iam.modules.col.parts')}</dt><dd>{parts.map(p => `${p.label} (${t(STATUS_TEXT[statusOf(p)])})`).join(', ')}</dd></> : null}
        {rights.length ? <><dt>{t('iam.modules.col.rights')}</dt><dd>{listAnd(rights)}</dd></> : null}
      </dl>
      {m.blockers?.length ? <div className="iam-mod-stop" role="note"><b>{t('iam.modules.blockersTitle')}</b><Blockers blockers={m.blockers} /></div> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------ Plattform-Administration

/**
 * Abschnitt «Module» in der Detailseite einer Organisation (Plattform-Administration): je Modul und Teilfunktion
 * freigeben bzw. entziehen. Entziehen deaktiviert mit (Rückfrage mit Wirkung); Hindernisse der App übergeht
 * «Trotzdem entziehen» (`?force=true`) nach Bestätigung. Nur mit Modulen im Modell.
 */
export function ModulesSection({ alias, orgLabel }: { alias: string; orgLabel: string }) {
  const { Button, Table, toast } = useIamUi();
  const fid = useId();
  useIamText();
  const feature = useModulesFeature();
  const cat = useAuthzCatalog();
  const q = useModules(alias, feature === true);
  const qc = useQueryClient();
  const [revoking, setRevoking] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const set = useMutation({
    mutationFn: ({ key, allowed, force }: { key: string; allowed: boolean; force?: boolean }) => { setErrorKey(key); return moduleApi(alias).setAllowed(key, allowed, { force, etag: q.data?.etag }); },
    onSuccess: (_r, v) => {
      const items = q.data?.items ?? [];
      toast.show(t(v.allowed ? 'iam.modules.platform.allowed' : 'iam.modules.platform.revoked', { name: quote(moduleLabel(items, v.key)), org: orgLabel }));
      setRevoking(null);
    },
    // Auch Sitzung und Katalog: ist es die Organisation dieses Tabs, ändern sich `modules` und Rechte
    onSettled: () => modulesChanged(qc, alias),
  });
  if (feature === undefined && cat.error) {
    return <section aria-labelledby={`${fid}-h`}><div className="iam-sec-h"><h2 id={`${fid}-h`}>{t('iam.modules.title')}</h2></div><ErrorState error={cat.error} onRetry={() => void cat.refetch()} /></section>;
  }
  if (feature !== true) return null;
  const items = q.data?.items ?? [];
  return (
    <section aria-labelledby={`${fid}-h`}>
      <div className="iam-sec-h"><h2 id={`${fid}-h`}>{t('iam.modules.title')}</h2></div>
      <p className="iam-muted iam-small">{t('iam.modules.platform.sub', { org: orgLabel })}</p>
      {q.isPending ? <SkeletonRows rows={3} cols={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          {set.error && !revoking ? <ModuleError error={set.error} items={items} moduleKey={errorKey ?? ''} onRetry={() => void q.refetch()} /> : null}
          <div className="iam-tblwrap">
            <Table stack>
              <caption className="iam-sr">{t('iam.modules.platform.caption', { org: orgLabel })}</caption>
              <thead><tr>
                <th scope="col">{t('iam.modules.col.module')}</th><th scope="col">{t('iam.modules.col.allowed')}</th><th scope="col">{t('iam.modules.col.state')}</th>
                <th scope="col" className="iam-acts"><span className="iam-sr">{t('iam.access.col.actions')}</span></th>
              </tr></thead>
              <tbody>
                {items.map((m, i) => (
                  <tr key={m.key}>
                    <td><div className={m.module ? 'iam-mod-indent' : undefined}><span className={m.module ? undefined : 'iam-b'}>{m.label}</span><div className="iam-mono-s iam-muted">{m.key}</div></div></td>
                    <td><span className="iam-st-lbl">{t('iam.modules.col.allowed')}:</span>{m.core ? t('iam.modules.platform.always') : m.allowed ? t('iam.modules.platform.yes') : t('iam.modules.platform.no')}</td>
                    <td><span className="iam-st-lbl">{t('iam.modules.col.state')}:</span><StatusPill m={m} /></td>
                    <td className="iam-acts">
                      {m.core ? (
                        <>
                          <Button size="sm" variant="ghost" aria-label={t('iam.modules.platform.revokeOf', { name: m.label })} aria-disabled aria-describedby={`${fid}-core-${i}`}>{t('iam.modules.platform.revoke')}</Button>
                          <span id={`${fid}-core-${i}`} className="iam-sr">{t('iam.modules.coreWhy')}</span>
                        </>
                      ) : m.allowed
                        ? <Button size="sm" variant="ghost" aria-label={t('iam.modules.platform.revokeOf', { name: m.label })} onClick={() => { set.reset(); setRevoking(m.key); }}>{t('iam.modules.platform.revoke')}</Button>
                        : <Button size="sm" aria-label={t('iam.modules.platform.allowOf', { name: m.label })} busy={set.isPending && set.variables?.key === m.key} onClick={() => set.mutate({ key: m.key, allowed: true })}>{t('iam.modules.platform.allow')}</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code tabIndex={0}>{`GET /v1/platform/organizations/${alias}/modules · PUT …/modules/{key}`}</code></div>
      {revoking && q.data ? (
        <RevokeDialog items={items} moduleKey={revoking} org={orgLabel} error={set.error} busy={set.isPending}
          onClose={() => { set.reset(); setRevoking(null); }} onConfirm={force => set.mutate({ key: revoking, allowed: false, force })} />
      ) : null}
    </section>
  );
}

/** Entziehen: Wirkung (deaktiviert mit, Daten bleiben); bei Hindernissen «Trotzdem entziehen» (force) als bewusste Wahl. */
function RevokeDialog({ items, moduleKey, org, error, busy, onClose, onConfirm }: { items: readonly TenantModule[]; moduleKey: string; org: string; error: unknown; busy: boolean; onClose: () => void; onConfirm: (force: boolean) => void }) {
  const { Dialog, Button } = useIamUi();
  const m = items.find(x => x.key === moduleKey)!;
  const serverErr = error ? moduleErrorText(error, items, m.key) : null;
  const blockers = serverErr?.blockers?.length ? serverErr.blockers : m.active ? m.blockers ?? [] : [];
  const deps = m.active && !m.module ? dependentsOf(items, m.key) : [];
  const force = blockers.length > 0;
  return (
    <Dialog title={t('iam.modules.platform.revokeTitle', { name: m.label, org })} role="alertdialog" width={480} onClose={onClose} initialFocus="[data-cancel]"
      footer={<><Button variant="ghost" data-cancel onClick={onClose}>{deps.length ? t('iam.common.close') : t('iam.common.cancel')}</Button>
        {deps.length ? null : <Button variant="danger-solid" data-confirm busy={busy} onClick={() => onConfirm(force)}>{force ? t('iam.modules.platform.revokeForce') : t('iam.modules.platform.revoke')}</Button>}</>}>
      {m.active ? <Effect items={items} m={m} org={org} /> : <p>{t('iam.modules.platform.revokeText', { name: quote(m.label), org })}</p>}
      {deps.length ? <div className="iam-mod-stop" role="note"><b>{t('iam.modules.platform.neededBy', { list: names(items, deps) })}</b></div> : null}
      {force ? (
        <div className="iam-mod-stop" role="note">
          <b>{t('iam.modules.blockersTitle')}</b><Blockers blockers={blockers} />
          <div>{t('iam.modules.platform.forceText', { org })}</div>
        </div>
      ) : null}
      {error && !serverErr?.blockers ? <ModuleError error={error} items={items} moduleKey={m.key} /> : null}
    </Dialog>
  );
}
