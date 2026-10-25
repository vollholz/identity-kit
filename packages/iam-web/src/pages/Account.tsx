/**
 * Konto ohne Organisation (Spezifikation Kap. 6.3, 11.1): Startseite der Sitzung, solange der Tab keine Organisation
 * hat – Organisationen wählen, eine eigene erstellen (`SELF_SERVICE_ORGS`), die Plattform-Administration öffnen.
 * Dazu der Rahmen der Plattform-Administration ohne Organisation (Organisationen, Rückkehr von Microsoft) und die
 * öffentliche Seite «Konto erstellen» (`SELF_SERVICE_SIGNUP`).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { accountApi, useAccount } from '../account.ts';
import { loginUrl } from '../client.ts';
import { useIamConfig } from '../config.tsx';
import type { Me } from '../contract.ts';
import { iamKeys } from '../keys.ts';
import { Gate, orgName } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { ErrorBox, ErrorState, Loading } from '../ui/states.tsx';
import { EntraConsentReturn } from './Entra.tsx';
import { OrganizationScreen, OrganizationsScreen } from './screens.tsx';

const ALIAS = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Alias als Vorschlag aus dem Namen: Kleinbuchstaben, Umlaute ohne Zeichen, sonst «-». */
const suggestAlias = (name: string) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

export interface AccountHomeProps {
  me: Me;
  switchOrg(alias: string): Promise<void>;
  logout(): Promise<void>;
}

/** Startseite ohne Organisation: Organisationen, eigene erstellen, Plattform-Administration, Abmelden. */
export function AccountHome({ me, switchOrg, logout }: AccountHomeProps) {
  const { Button } = useIamUi();
  const { paths, router } = useIamConfig();
  useIamText();
  const account = useAccount();
  const [creating, setCreating] = useState(false);
  if (account.isPending) return <div className="iam-gate"><Loading /></div>;
  if (account.error) return <div className="iam-gate"><ErrorState error={account.error} onRetry={() => void account.refetch()} /></div>;
  const a = account.data;
  const orgs = me.organizations;
  const canCreate = a.selfService.createOrganization;
  // Mit Organisationen wie bisher «Organisation wählen» (mit dem Grund, falls die gewählte fehlt), sonst das Konto
  const title = orgs.length ? t('iam.org.choose') : t('iam.account.home');
  const text = orgs.length ? me.tenantError ?? t('iam.org.choose.text')
    : a.platformAdmin ? t('iam.account.text') : `${t('iam.account.none')} ${canCreate ? t('iam.account.noneCreate') : t('iam.account.noneWait')}`;
  return (
    <Gate title={title} text={text}>
      <p className="iam-muted iam-small">{a.account.name}{a.account.email ? ` · ${a.account.email}` : ''}</p>
      {orgs.length ? (
        <div className="iam-org-list" role="group" aria-label={t('iam.org.choose')}>
          {orgs.map(o => {
            const st = a.organizations.find(x => x.alias === o)?.status;
            return (
              <Button key={o} icon="building" onClick={() => void switchOrg(o)}>
                {orgName(me, o)}{st && st !== 'active' ? <span className="iam-muted iam-small"> · {t(st === 'suspended' ? 'iam.orgs.suspended' : 'iam.account.orgUnavailable')}</span> : null}
              </Button>
            );
          })}
        </div>
      ) : null}
      {a.platformAdmin ? (
        <section className="iam-account-sec" aria-label={t('iam.account.platform')}>
          <h2>{t('iam.account.platform')}</h2>
          <p className="iam-muted iam-small">{t('iam.account.platformHint')}</p>
          <Button variant="primary" icon="building" onClick={() => router.navigate(paths.organizations)}>{t('iam.account.platformOpen')}</Button>
        </section>
      ) : null}
      {canCreate ? (
        creating ? <CreateOwnOrg emailVerified={a.account.emailVerified} limit={a.selfService.organizationLimit} onCancel={() => setCreating(false)} onCreated={alias => switchOrg(alias)} />
          : <Button variant={orgs.length || a.platformAdmin ? 'ghost' : 'primary'} icon="plus" onClick={() => setCreating(true)}>{t('iam.account.create')}</Button>
      ) : null}
      <button type="button" className="iam-linkbtn" onClick={() => void logout()}>{t('iam.session.logout')}</button>
    </Gate>
  );
}

/** Eigene Organisation: Name und Alias; danach Wechsel in die neue Organisation (erneuert das Token). */
function CreateOwnOrg({ emailVerified, limit, onCancel, onCreated }: { emailVerified: boolean; limit: number; onCancel: () => void; onCreated: (alias: string) => Promise<void> }) {
  const { Button, Icon, toast } = useIamUi();
  const fid = useId();
  const qc = useQueryClient();
  const [d, setD] = useState({ name: '', alias: '' });
  const [aliasTouched, setAliasTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const nameErr = tried && !d.name.trim() ? t('iam.orgs.nameMissingShort') : null;
  const aliasErr = d.alias && !ALIAS.test(d.alias) ? t('iam.orgs.aliasInvalid') : tried && !d.alias ? t('iam.orgs.aliasMissing') : null;
  const save = useMutation({
    mutationFn: () => accountApi.createOrganization({ alias: d.alias, name: d.name.trim() }),
    onSuccess: async o => { toast.show(t('iam.account.created', { org: o.name })); await qc.invalidateQueries({ queryKey: iamKeys.account }); await onCreated(o.alias); },
  });
  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    setTried(true);
    const first = !d.name.trim() ? `${fid}-n` : !d.alias || !ALIAS.test(d.alias) ? `${fid}-a` : null;
    if (first) { document.getElementById(first)?.focus(); return; }
    save.mutate();
  };
  if (!emailVerified) return <p className="iam-note" role="note"><Icon name="warn" className="iam-ico" />{t('iam.account.unverified')}</p>;
  return (
    <form className="iam-account-sec" onSubmit={submit} noValidate aria-label={t('iam.account.create')}>
      <h2>{t('iam.account.create')}</h2>
      <p className="iam-muted iam-small">{t('iam.account.createText')} {t('iam.account.createLimit', { n: String(limit) })}</p>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-n`}>{t('iam.orgs.name')}</label>
        <input id={`${fid}-n`} className="iam-inp" value={d.name} autoFocus required autoComplete="organization" aria-invalid={nameErr ? true : undefined} aria-describedby={nameErr ? `${fid}-n-e` : undefined}
          onChange={e => setD({ name: e.target.value, alias: aliasTouched ? d.alias : suggestAlias(e.target.value) })} />
        {nameErr ? <div id={`${fid}-n-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{nameErr}</div> : null}
        <label htmlFor={`${fid}-a`}>{t('iam.orgs.alias')}</label>
        <input id={`${fid}-a`} className="iam-inp iam-mono" value={d.alias} required autoComplete="off" aria-invalid={aliasErr ? true : undefined} aria-describedby={`${fid}-a-h`}
          onChange={e => { setAliasTouched(true); setD({ ...d, alias: e.target.value }); }} />
        <div id={`${fid}-a-h`} className={aliasErr ? 'iam-ferr iam-hint' : 'iam-hint'}>{aliasErr ? <><Icon name="warn" className="iam-ico" />{aliasErr}</> : t('iam.orgs.aliasHint')}</div>
      </div>
      {save.error ? <ErrorBox error={save.error} /> : null}
      <div className="iam-account-actions">
        <Button variant="ghost" onClick={onCancel}>{t('iam.common.cancel')}</Button>
        <Button type="submit" variant="primary" busy={save.isPending}>{t('iam.account.create')}</Button>
      </div>
    </form>
  );
}

/**
 * Plattform-Administration ohne Organisation: Organisationen (Liste, Detail) und die Rückkehr von Microsoft unter dem
 * eigenen Rahmen mit «Zum Konto» und «Abmelden». `route`: welche Seite der Pfad meint.
 */
export function PlatformShell({ route, logout }: { route: 'organizations' | 'organization' | 'entraConsent'; logout(): Promise<void> }) {
  const { product, brand, paths, router } = useIamConfig();
  useIamText();
  return (
    <div className="iam-platform">
      <header className="iam-platform-head">
        {brand ?? (product ? <div className="iam-brand"><span className="iam-bt">{product}</span></div> : null)}
        <span className="iam-muted iam-small">{t('iam.account.platform')}</span>
        <span className="iam-sp" />
        <button type="button" className="iam-linkbtn" onClick={() => router.navigate(paths.home)}>{t('iam.account.back')}</button>
        <button type="button" className="iam-linkbtn" onClick={() => void logout()}>{t('iam.session.logout')}</button>
      </header>
      <main className="iam-platform-main">
        {route === 'organizations' ? <OrganizationsScreen /> : route === 'organization' ? <OrganizationScreen /> : <EntraConsentReturn />}
      </main>
    </div>
  );
}

/** Öffentliche Seite «Konto erstellen»: E-Mail und Name; die Antwort verrät nicht, ob schon ein Konto besteht. */
export function SignupPage() {
  const { Button, Icon } = useIamUi();
  const { paths } = useIamConfig();
  useIamText();
  const fid = useId();
  const [d, setD] = useState({ email: '', firstName: '', lastName: '' });
  const [tried, setTried] = useState(false);
  const emailErr = tried && !EMAIL.test(d.email.trim()) ? t('iam.signup.emailInvalid') : null;
  const send = useMutation({ mutationFn: () => accountApi.signup({ email: d.email.trim(), ...(d.firstName.trim() ? { firstName: d.firstName.trim() } : {}), ...(d.lastName.trim() ? { lastName: d.lastName.trim() } : {}) }) });
  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    setTried(true);
    if (!EMAIL.test(d.email.trim())) { document.getElementById(`${fid}-e`)?.focus(); return; }
    send.mutate();
  };
  const login = <a className="iam-linkbtn" href={loginUrl(paths.home)}>{t('iam.signup.login')}</a>;
  if (send.isSuccess) return <Gate title={t('iam.signup.done.title')} text={t('iam.signup.done.text', { email: d.email.trim() })}>{login}</Gate>;
  const field = (k: 'firstName' | 'lastName', label: string, auto: string): ReactNode => (
    <><label htmlFor={`${fid}-${k}`}>{label}</label><input id={`${fid}-${k}`} className="iam-inp" value={d[k]} autoComplete={auto} onChange={e => setD({ ...d, [k]: e.target.value })} /></>
  );
  return (
    <Gate title={t('iam.signup.title')} text={t('iam.signup.text')}>
      <form onSubmit={submit} noValidate className="iam-account-sec">
        <div className="iam-form iam-compact">
          <label htmlFor={`${fid}-e`}>{t('iam.signup.email')}</label>
          <input id={`${fid}-e`} className="iam-inp" type="email" value={d.email} autoFocus required autoComplete="email" aria-invalid={emailErr ? true : undefined} aria-describedby={emailErr ? `${fid}-e-e` : undefined}
            onChange={e => setD({ ...d, email: e.target.value })} />
          {emailErr ? <div id={`${fid}-e-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{emailErr}</div> : null}
          {field('firstName', t('iam.signup.first'), 'given-name')}
          {field('lastName', t('iam.signup.last'), 'family-name')}
        </div>
        {send.error ? <ErrorBox error={send.error} /> : null}
        <Button type="submit" variant="primary" busy={send.isPending}>{t('iam.signup.submit')}</Button>
      </form>
      {login}
    </Gate>
  );
}
