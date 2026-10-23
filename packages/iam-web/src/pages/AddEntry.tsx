/**
 * Dialog «Zugriffsregel hinzufügen»: Wirkung Freigeben, Beschränken auf oder Verbieten; je Ressourcentyp nur passende
 * Rechte (Katalog, ohne Rechte nur von org-admin, ausser Verbot oder Beschränkung für einen Maschinen-Client), Rolle
 * org-admin nicht wählbar, Person über die Suche, Maschinen-Client aus den freigegebenen (mit `members:admin`), Gruppe
 * als geprüfter Freitext, Ressource über den Adapter `resources`. Freigeben geht auch für alle Rechte einer Rolle auf
 * einmal («Bearbeiter:in nur im Ordner X»): dann ein Eintrag je passendem Recht. Vor dem Speichern eine Vorschau der
 * Folgen; Feldfehler des Servers (422) am Feld, fehlende Angaben beim Absenden mit Fokus aufs Feld. Nennt die
 * Organisation, in der die Zugriffsregel gilt. Herkunft: vollholz/assets `web/src/features/acl/AddEntry.tsx`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useClientGrants } from '../admin.ts';
import { aclResourceTypes, belowText, effectOf, effectText, EFFECT_KEYS, permissionsFor, previewEntry, whereText, type AclLike, type Effect, type ResStep } from '../acl/rules.ts';
import { aclApi, PersonPick, principalTypes, ResourcePick, usePermLabel, useResources, useWhoText } from '../acl/shared.tsx';
import { useAuthz } from '../authz.ts';
import { useIamConfig } from '../config.tsx';
import type { AclEntry, AclPrincipalType } from '../contract.ts';
import { iamKeys } from '../keys.ts';
import { ADMIN_ROLE, type Permission } from '../permissions.ts';
import { ApiError } from '../problem.ts';
import { useIam } from '../session.tsx';
import { t, tn, type IamTextKey } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { ErrorBox } from '../ui/states.tsx';

type Draft = { resourceType: string; resourceId: string; principalType: AclPrincipalType; principalRef: string; permission: string; effect: Effect };

/** Gruppenpfad wie in Keycloak: beginnt mit «/», endet nicht mit «/». */
export const groupPathError = (v: string) => (!v || (v.startsWith('/') && v.length > 1 && !v.endsWith('/')) ? null : t('iam.acl.groupPath'));

const OUTCOME_PILL: Record<string, string> = { gains: 'iam-st-ok', keeps: 'iam-st-ok', loses: 'iam-st-bad', without: 'iam-st-off', exempt: 'iam-st-ok' };
const outcomeText = (o: string) => t(`iam.acl.outcome.${o}` as IamTextKey);

/** Stufe über der Ressource ohne Adapterkette: noch unbekannt, die Vorschau rechnet mit Organisation und Ressource. */
const noChain = () => [];

export function AddEntry({ entries, onClose }: { entries: AclEntry[]; onClose: () => void }) {
  const authz = useAuthz();
  const { me, can, orgName: org } = useIam();
  const { resources, groupRolePrefix = '/orgs' } = useIamConfig();
  const { Dialog, Button, toast } = useIamUi();
  useIamText();
  const fid = useId();
  const ids = { rt: `${fid}-rt`, rid: `${fid}-rid`, pt: `${fid}-pt`, pr: `${fid}-pr`, eff: `${fid}-eff`, what: `${fid}-what`, bundle: `${fid}-bundle`, perm: `${fid}-perm` };
  const qc = useQueryClient();
  const res = useResources();
  const who = useWhoText();
  const perm = usePermLabel();
  const manageClients = can('members:admin');
  const clients = useClientGrants(null, manageClients);
  const c = authz.catalog;
  const roles = (c?.roles ?? []).filter(r => r.key !== ADMIN_ROLE);
  const fitting = (x: Pick<Draft, 'resourceType' | 'effect' | 'principalType'>) => (c ? permissionsFor(c, x.resourceType, { effect: x.effect, principalType: x.principalType }) : []);
  // Vorgabe: erster Typ unter der Organisation, erste Rolle ausser org-admin, erstes passendes Recht, «Beschränken auf»
  const [d, setD] = useState<Draft>(() => {
    const types = aclResourceTypes(c);
    const resourceType = types.find(r => r.key !== 'tenant')?.key ?? 'tenant';
    const first: Draft = { resourceType, resourceId: '', principalType: 'role', principalRef: roles[0]?.key ?? '', permission: '', effect: 'restrict' };
    return { ...first, permission: fitting(first)[0]?.key ?? '' };
  });
  // Freigeben: ein Recht oder alle passenden Rechte einer Rolle («Rolle im Bereich»)
  const [bundle, setBundle] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const perms = fitting(d);
  const leafNow = res.leaves.includes(d.resourceType);
  const bundleRole = bundle ? roles.find(r => r.key === bundle) : undefined;
  // Rechte der Rolle, die auf diesem Ressourcentyp als Freigabe wirken
  const bundlePerms = bundleRole ? perms.filter(p => bundleRole.permissions.includes(p.key)).map(p => p.key) : [];
  const ridNow = d.resourceType === 'tenant' ? null : d.resourceId || null;
  const isExisting = (p: string, effect: string) => entries.some(e => e.resourceType === d.resourceType && (e.resourceId ?? null) === ridNow && e.principalType === d.principalType
    && e.principalRef === d.principalRef && e.permission === p && effectOf(e) === effect);
  const toSave = bundleRole && d.effect === 'grant' ? bundlePerms.filter(p => !isExisting(p, 'grant')) : [d.permission];
  const save = useMutation({
    mutationFn: async () => {
      for (const permission of toSave) {
        await aclApi.create({ resourceType: d.resourceType, resourceId: ridNow, principalType: d.principalType, principalRef: d.principalRef, permission: permission as Permission, effect: d.effect });
      }
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: iamKeys.acl }); toast.show(tn('iam.acl.added', toSave.length, { org })); onClose(); },
    // Teilweise gespeichert (Rolle im Bereich): Liste aktualisieren, Fehler bleibt im Dialog
    onError: () => void qc.invalidateQueries({ queryKey: iamKeys.acl }),
  });
  const keepPerm = (next: Draft) => {
    const fits = fitting(next);
    return { ...next, permission: fits.some(p => p.key === next.permission) ? next.permission : fits[0]?.key ?? next.permission };
  };
  const setType = (resourceType: string) => {
    const leaf = res.leaves.includes(resourceType);
    if (leaf) setBundle(null);
    setD(keepPerm({ ...d, resourceType, resourceId: '', effect: leaf && d.effect === 'grant' ? 'restrict' : d.effect }));
  };
  const setEffect = (effect: Effect) => {
    if (effect === 'grant' && leafNow) return;
    if (effect !== 'grant') setBundle(null);
    setD(keepPerm({ ...d, effect }));
  };

  const fieldErrs = save.error instanceof ApiError ? save.error.fieldErrors : [];
  const fe = (path: string) => fieldErrs.find(f => f.path === path)?.message;
  const groupErr = d.principalType === 'group' ? groupPathError(d.principalRef) : null;
  const refErr = (tried && groupErr) || fe('/principalRef');
  const missing = tried && !d.principalRef ? t('iam.acl.required') : null;
  const resErr = (tried && d.resourceType !== 'tenant' && !d.resourceId ? t('iam.acl.choose') : null) || fe('/resourceId');
  const permErr = fe('/permission');
  const shown = new Set(['/principalRef', '/resourceId', '/permission']);
  const rest = save.error && !fieldErrs.some(f => shown.has(f.path));

  const ready = c && d.principalRef && d.permission && (d.resourceType === 'tenant' || d.resourceId) && !groupErr && (!bundle || bundlePerms.length > 0);
  const exists = bundleRole ? bundlePerms.length > 0 && toSave.length === 0 : isExisting(d.permission, d.effect);
  const above = (resources?.useChain ?? noChain)(d.resourceType, ridNow) ?? [];
  const chain: ResStep[] = [{ type: 'tenant', id: null }, ...(d.resourceType === 'tenant' ? [] : [...above.map(s => ({ type: s.type, id: s.id })), { type: d.resourceType, id: ridNow }])];
  const draft: AclLike = { ...d, resourceId: ridNow };
  const resourceName = res.name(d.resourceType, ridNow);
  const preview = ready && !bundleRole ? previewEntry({ draft, entries, chain, catalog: c, resourceName, who, leaves: res.leaves }) : null;
  const plural = d.principalType === 'role' || d.principalType === 'group';
  const prLabel = d.principalType === 'role' ? t('iam.acl.pr.role') : d.principalType === 'group' ? t('iam.acl.pr.group') : d.principalType === 'client' ? t('iam.acl.pr.client') : t('iam.acl.pr.user');
  const groupExample = `${groupRolePrefix.replace(/\/+$/, '')}/${me.tenant?.alias ?? '<alias>'}`;

  const submit = () => {
    setTried(true);
    // Fehlende Angabe: Fokus auf das erste betroffene Feld
    const first = d.resourceType !== 'tenant' && !d.resourceId ? ids.rid : !d.principalRef || groupErr ? ids.pr : null;
    if (first) { document.getElementById(first)?.focus(); return; }
    if (ready && !exists) save.mutate();
  };
  return (
    <Dialog title={t('iam.acl.add.title', { org })} onClose={onClose} onSubmit={submit} width={600}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" disabled={save.isPending || exists} busy={save.isPending}>{t('iam.acl.add.confirm')}</Button></>}>
      <div className="iam-field"><label htmlFor={ids.rt}>{t('iam.acl.resource')}</label>
        <select id={ids.rt} className="iam-inp" value={d.resourceType} onChange={e => setType(e.target.value)} data-autofocus>{aclResourceTypes(c).map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select></div>
      {d.resourceType !== 'tenant' ? (
        <div className="iam-field"><label htmlFor={ids.rid}>{authz.resourceLabel(d.resourceType)}</label>
          <ResourcePick id={ids.rid} type={d.resourceType} value={d.resourceId} onChange={v => setD({ ...d, resourceId: v })} invalid={!!resErr} describedBy={resErr ? `${ids.rid}-e` : undefined} />
          {resErr ? <span id={`${ids.rid}-e`} className="iam-ferr iam-span2">{resErr}</span> : null}
        </div>
      ) : null}
      <div className="iam-field"><label htmlFor={ids.pt}>{t('iam.acl.col.who')}</label>
        <select id={ids.pt} className="iam-inp" value={d.principalType} onChange={e => { const pt = e.target.value as AclPrincipalType; setD(keepPerm({ ...d, principalType: pt, principalRef: pt === 'role' ? roles[0]?.key ?? '' : '' })); }}>
          {principalTypes().map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div className="iam-field"><label htmlFor={ids.pr}>{prLabel}</label>
        {d.principalType === 'role'
          ? <select id={ids.pr} className="iam-inp" value={d.principalRef} onChange={e => setD({ ...d, principalRef: e.target.value })} aria-invalid={!!refErr || undefined} aria-describedby={`${ids.pr}-e`}>{roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
          : d.principalType === 'user'
            ? <PersonPick id={ids.pr} value={d.principalRef} onChange={v => setD({ ...d, principalRef: v })} describedBy={`${ids.pr}-e`} invalid={!!(refErr || missing)} />
            : d.principalType === 'client' && manageClients && clients.data
              ? <select id={ids.pr} className="iam-inp" value={d.principalRef} onChange={e => setD({ ...d, principalRef: e.target.value })} aria-invalid={!!(refErr || missing) || undefined} aria-describedby={`${ids.pr}-e`}>
                <option value="">{t('iam.acl.choosePlain')}</option>{clients.data.map(x => <option key={x.clientId} value={x.clientId}>{x.description ? `${x.description} (${x.clientId})` : x.clientId}</option>)}</select>
              : <input id={ids.pr} className="iam-inp iam-mono-s" value={d.principalRef} onChange={e => setD({ ...d, principalRef: e.target.value })} autoComplete="off"
                placeholder={d.principalType === 'group' ? `${groupExample}/team` : t('iam.acl.clientId')} aria-invalid={!!(refErr || missing) || undefined} aria-describedby={`${ids.pr}-e`} />}
        {refErr || missing ? <span id={`${ids.pr}-e`} className="iam-ferr iam-span2">{refErr || missing}</span>
          : d.principalType === 'group' ? <span id={`${ids.pr}-e`} className="iam-span2 iam-muted iam-small">{t('iam.acl.groupExample', { example: `${groupExample}/…` })}</span>
            : d.principalType === 'role' ? <span id={`${ids.pr}-e`} className="iam-span2 iam-muted iam-small">{t('iam.acl.adminExempt', { admin: authz.roleLabel(ADMIN_ROLE) })}</span> : null}
      </div>
      <div className="iam-field"><span className="iam-flbl" id={ids.eff}>{t('iam.acl.effect')}</span>
        <div className="iam-seg" role="group" aria-labelledby={ids.eff}>
          {EFFECT_KEYS.map(x => {
            const blocked = x === 'grant' && leafNow;
            return (
              <button key={x} type="button" aria-pressed={d.effect === x} onClick={() => setEffect(x)} aria-disabled={blocked || undefined}
                title={blocked ? t('iam.acl.why.leaf', { type: authz.resourceLabel(d.resourceType) }) : effectText(x, 'hint')}>{effectText(x, 'label')}</button>
            );
          })}
        </div>
        <span className="iam-span2 iam-muted iam-small">{effectText(d.effect, 'label')}: {effectText(d.effect, 'hint')}.</span></div>
      {d.effect === 'grant' ? (
        <div className="iam-field"><span className="iam-flbl" id={ids.what}>{t('iam.acl.what')}</span>
          <div className="iam-seg" role="group" aria-labelledby={ids.what}>
            <button type="button" aria-pressed={!bundle} onClick={() => setBundle(null)}>{t('iam.acl.what.one')}</button>
            <button type="button" aria-pressed={!!bundle} onClick={() => setBundle(bundle ?? roles[0]?.key ?? null)}>{t('iam.acl.what.role')}</button>
          </div></div>
      ) : null}
      {bundle ? (
        <div className="iam-field"><label htmlFor={ids.bundle}>{t('iam.acl.bundle')}</label>
          <select id={ids.bundle} className="iam-inp" value={bundle} onChange={e => setBundle(e.target.value)}>{roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
          <span className="iam-span2 iam-muted iam-small">{bundlePerms.length
            ? tn('iam.acl.bundle.perms', bundlePerms.length, { perms: bundlePerms.map(perm).join(', ') })
            : t('iam.acl.bundle.none', { type: authz.resourceLabel(d.resourceType) })}</span>
        </div>
      ) : (
        <div className="iam-field"><label htmlFor={ids.perm}>{t('iam.acl.perm')}</label>
          <select id={ids.perm} className="iam-inp" value={d.permission} onChange={e => setD({ ...d, permission: e.target.value })} aria-invalid={!!permErr || undefined} aria-describedby={permErr ? `${ids.perm}-e` : undefined}>
            {(c?.groups ?? []).map(g => { const ps = perms.filter(p => p.group === g.key); return ps.length ? <optgroup key={g.key} label={g.label}>{ps.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</optgroup> : null; })}
          </select>
          {permErr ? <span id={`${ids.perm}-e`} className="iam-ferr iam-span2">{permErr}</span> : null}
        </div>
      )}
      {exists ? <div className="iam-errbox" role="alert">{t(bundleRole ? 'iam.acl.exists.bundle' : 'iam.acl.exists')}</div> : bundleRole && ready ? (
        <div className="iam-card iam-pad" role="status" aria-label={t('iam.acl.preview')}>
          <p><b>{t('iam.acl.preview')}:</b> {tn('iam.acl.preview.bundle', plural ? 2 : 1, { where: whereText(c, d.resourceType, resourceName), who: who(draft), role: bundleRole.label, below: belowText(d.resourceType, res.leaves), perms: bundlePerms.map(perm).join(', ') })}</p>
          <p className="iam-muted iam-small">{toSave.length === bundlePerms.length ? tn('iam.acl.preview.bundleAll', toSave.length) : t('iam.acl.preview.bundleSome', { new: tn('iam.acl.preview.bundleNew', toSave.length), old: tn('iam.acl.preview.bundleOld', bundlePerms.length - toSave.length) })} {t('iam.acl.preview.still')}</p>
        </div>
      ) : preview ? (
        <div className="iam-card iam-pad" role="status" aria-label={t('iam.acl.preview')}>
          <p><b>{t('iam.acl.preview')}:</b> {preview.sentence}</p>
          {preview.unchanged && d.effect !== 'grant' ? <p>{t('iam.acl.preview.unchanged')}</p> : null}
          {preview.others > 0 ? <p className="iam-muted iam-small">{tn('iam.acl.preview.others', preview.others)}</p> : null}
          {d.effect !== 'grant' || d.principalType === 'role' ? (
            <ul className="iam-plain-list" aria-label={t('iam.acl.preview.roles')}>
              {preview.roles.map(r => <li key={r.key}><span className={`iam-pill iam-sm ${OUTCOME_PILL[r.outcome]}`}>{outcomeText(r.outcome)}</span> {r.label}</li>)}
            </ul>
          ) : null}
          {preview.individual ? <p className="iam-muted iam-small">{t('iam.acl.preview.individual')}</p> : null}
          {resources && !resources.useChain && d.resourceType !== 'tenant' ? <p className="iam-muted iam-small">{t('iam.acl.preview.noChain')}</p> : null}
        </div>
      ) : <p className="iam-muted iam-small">{t('iam.acl.preview.help')}</p>}
      {rest ? <ErrorBox error={save.error} compact /> : null}
    </Dialog>
  );
}
