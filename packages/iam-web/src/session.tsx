/**
 * Sitzung über den BFF (Spezifikation 5, 11.1): /auth/me liefert Person, Organisation, Rechte und CSRF-Token.
 * - Organisation je Tab: liegt im sessionStorage (tabOrg.ts) und geht als `X-Tenant` mit jeder Anfrage an /v1 und
 *   /auth/me. Ohne eigene Wahl übernimmt der Tab die Vorgabe der Sitzung und merkt sie sich. Ein Wechsel setzt die
 *   Organisation dieses Tabs und die Vorgabe der Sitzung; andere Tabs bleiben, wo sie sind.
 * - nicht angemeldet → Weiterleitung zu /auth/login (mit Rücksprung)
 * - mehrere Organisationen ohne Auswahl → Auswahlseite
 * - Organisation des Tabs nicht mehr verfügbar (Austritt, nicht mehr im Token, gesperrt) → Hinweis mit Auswahl und
 *   «Neu laden» statt Daten einer anderen Organisation; jedes 403 lässt /auth/me das prüfen
 * - anderer Mandant im Tab → Cache leeren (ausser /auth/me), nichts aus der vorigen Organisation weiterzeigen
 * - Sitzung abgelaufen (401) → Dialog «Erneut anmelden», ungespeicherte Eingaben bleiben sichtbar
 * - Abmelden entfernt die Organisation des Tabs; persönliche Daten der App über `onLogout`
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Component, createContext, Fragment, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authFetch, loginUrl, onForbidden, onSessionExpired, reportStatus, setCsrfToken, setTenant } from './client.ts';
import { useIamConfig, type IamConfig } from './config.tsx';
import type { Me, SwitchResult } from './contract.ts';
import { isHandoverPath, publicEntraPage, takeHandoverToken } from './entra.ts';
import { iamKeys } from './keys.ts';
import type { Permission } from './permissions.ts';
import { ApiError, errorFrom } from './problem.ts';
import { readTabOrg, tabOrgFor, writeTabOrg } from './tabOrg.ts';
import { t } from './texts/index.ts';
import { useIamUi } from './ui/context.tsx';
import { ErrorState, Loading } from './ui/states.tsx';

export interface IamSession {
  me: Me;
  /** Recht an der Organisation (Rolle an `org`, `permissions`). */
  can(p: Permission): boolean;
  /**
   * Recht irgendwo: an der Organisation oder an mindestens einem Ort (`somewhere`, Spezifikation 7.5). Für Navigation
   * und Listen, die je Ressource filtern; Aktionen ohne Ressource (z. B. anlegen) prüfen mit `can`, Aktionen an einer
   * Ressource mit deren `can` (`useResourceCan`).
   */
  canSomewhere(p: Permission): boolean;
  switchOrg(alias: string): Promise<void>;
  logout(): Promise<void>;
  /** Name der Organisation dieses Tabs (sonst der Alias). */
  orgName: string;
}

const Ctx = createContext<IamSession | null>(null);

/** Name einer Organisation der Person (ohne bekannten oder mit leerem Namen der Alias). */
export function orgName(me: Me, alias: string): string {
  return me.organizationNames?.[alias] || (me.tenant?.alias === alias ? me.tenant.name : '') || alias;
}

/** Name der Organisation dieses Tabs. */
export const tenantName = (me: Me): string => (me.tenant ? me.tenant.name || orgName(me, me.tenant.alias) : '');

function makeSession(me: Me, switchOrg: IamSession['switchOrg'], logout: IamSession['logout']): IamSession {
  const somewhere = me.somewhere ?? [];
  return {
    me, switchOrg, logout, orgName: tenantName(me),
    can: p => me.permissions.includes(p),
    canSomewhere: p => me.permissions.includes(p) || somewhere.includes(p),
  };
}

/**
 * Organisation und CSRF-Token für die Anfragen danach – sofort, bevor Kinder zeichnen (auch ihre Layout-Effekte schreiben
 * schon mit Token); die App erfährt Person und Organisation (`onTenant`).
 */
function applyMe(me: Me, config: IamConfig) {
  if (me.tenant) setTenant(me.tenant.alias);
  setCsrfToken(me.csrfToken);
  config.onTenant?.(me);
}

const notMe = { predicate: (q: { queryKey: readonly unknown[] }) => !(q.queryKey[0] === iamKeys.me[0] && q.queryKey[1] === iamKeys.me[1]) };

/**
 * Alle Daten ausser /auth/me aus dem Cache: nichts aus einer anderen Organisation oder von einer anderen Person
 * weiterzeigen. Laufende Abfragen werden abgebrochen, damit keine späte Antwort die alten Daten zurückschreibt; die
 * Kinder der Sitzung werden danach neu eingehängt (Schlüssel aus Person und Organisation) und laden neu.
 */
async function clearTenantData(qc: QueryClient) {
  await qc.cancelQueries(notMe);
  qc.removeQueries(notMe);
  qc.getMutationCache().clear();
}

/** Person und Organisation einer Antwort von /auth/me; ändert sich der Wert, gehört der Cache jemand anderem. */
const scopeOf = (me: Me | undefined) => (me ? `${me.person.subject}:${me.tenant?.id ?? ''}` : '');

async function getMe(): Promise<Me> {
  const r = await authFetch('/auth/me');
  if (!r.ok) throw await errorFrom(r);
  return (await r.json()) as Me;
}

/** /auth/me für die Organisation dieses Tabs; ohne eigene Wahl gilt die Vorgabe der Sitzung, die sich der Tab merkt. */
async function fetchMe(qc: QueryClient, config: IamConfig): Promise<Me> {
  const tab = readTabOrg();
  setTenant(tab?.alias ?? null);
  let me = await getMe();
  if (tab && !tabOrgFor(me.person.subject)) {
    // Im Tab hat sich eine andere Person angemeldet: ihre Vorgabe gilt, nicht die frühere Wahl
    setTenant(null);
    me = await getMe();
  }
  if (me.tenant) writeTabOrg({ sub: me.person.subject, alias: me.tenant.alias, name: tenantName(me) });
  // Andere Organisation (neue ID) oder andere Person im selben Tab (z. B. in einem anderen Tab ab- und neu angemeldet)
  const before = qc.getQueryData<Me>(iamKeys.me);
  if (before && scopeOf(before) !== scopeOf(me)) await clearTenantData(qc);
  applyMe(me, config);
  return me;
}

/** Organisation des Tabs, die /auth/me nicht (mehr) liefert, z. B. nach einem Austritt; sonst null. */
function unavailableOrg(me: Me): { alias: string; name: string } | null {
  const tab = readTabOrg();
  return !me.tenant && tab && tab.sub === me.person.subject ? { alias: tab.alias, name: tab.name ?? orgName(me, tab.alias) } : null;
}

/** Öffentliche Seiten der Entra-Freigabe: aus `./pages` nachgeladen, damit der Kern klein bleibt. */
const HandoverPage = lazy(() => import('./pages/index.ts').then(m => ({ default: m.EntraHandoverPage })));
const HandoverReturn = lazy(() => import('./pages/index.ts').then(m => ({ default: m.EntraHandoverReturn })));
/** Ohne Organisation (Kap. 6.3): Konto, Plattform-Administration, Registrieren – ebenfalls nachgeladen. */
const AccountHome = lazy(() => import('./pages/index.ts').then(m => ({ default: m.AccountHome })));
const PlatformShell = lazy(() => import('./pages/index.ts').then(m => ({ default: m.PlatformShell })));
const SignupPage = lazy(() => import('./pages/index.ts').then(m => ({ default: m.SignupPage })));

/** Seite der Plattform-Administration, die auch ohne Organisation läuft, oder null. */
function platformRoute(config: IamConfig, pathname: string): 'organizations' | 'organization' | 'entraConsent' | null {
  if (config.features.platform === false) return null;
  const o = config.paths.organizations;
  if (pathname === o || pathname === `${o}/`) return 'organizations';
  if (pathname.startsWith(`${o}/`)) return 'organization';
  return config.features.entra && pathname === `${config.paths.entra}/zustimmung` ? 'entraConsent' : null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const config = useIamConfig();
  const { Dialog, Button, toast } = useIamUi();
  const qc = useQueryClient();
  // Öffentliche Seite nach dem Abmelden (post_logout_redirect_uri): ohne /auth/me, damit sie nicht gleich zur Anmeldung weiterleitet
  const [loggedOut] = useState(() => window.location.pathname === config.paths.loggedOut);
  // «Konto erstellen»: öffentlich, ohne Sitzung (nur mit features.signup)
  const [signup] = useState(() => !!config.features.signup && window.location.pathname === config.paths.signup);
  const pathname = config.router.usePathname();
  // Link an die Entra-Administration und seine Rückkehr: öffentlich, ohne Sitzung (nur mit features.entra)
  // Das Token der Freigabe sofort aus der Adresse nehmen (vor dem Nachladen, vor Telemetrie und Weiterleitungen); auf
  // …/freigabe auch dann, wenn die Seite nicht erkannt ist (features.entra fehlt, anderer Pfad)
  const [{ page: entraPublic, token: handoverToken }] = useState(() => {
    const page = config.features.entra ? publicEntraPage(config.paths.entra, window.location) : null;
    const token = page === 'handover' || isHandoverPath(window.location.pathname) ? takeHandoverToken() : null;
    return { page, token };
  });
  const meQ = useQuery({
    queryKey: iamKeys.me, queryFn: () => fetchMe(qc, config), enabled: !loggedOut && !entraPublic && !signup,
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2, refetchOnWindowFocus: true, staleTime: 60_000,
  });
  const [expired, setExpired] = useState(false);

  useEffect(() => { setCsrfToken(meQ.data?.csrfToken ?? null); }, [meQ.data?.csrfToken]);
  useEffect(() => onSessionExpired(() => { if (meQ.data) setExpired(true); }), [meQ.data]);
  // 403: fehlt nur ein Recht, oder ist die Organisation des Tabs nicht mehr verfügbar? /auth/me entscheidet
  useEffect(() => onForbidden(() => { void qc.refetchQueries({ queryKey: iamKeys.me }, { cancelRefetch: false }); }), [qc]);
  // Erneute Prüfung beim Zurückkehren in den Tab: abgelaufene Sitzung früh erkennen
  useEffect(() => { if (meQ.error instanceof ApiError && meQ.error.status === 401 && qc.getQueryData(iamKeys.me)) setExpired(true); }, [meQ.error, qc]);

  // Wechsel: POST mit X-CSRF-Token setzt die Vorgabe der Sitzung, die Organisation dieses Tabs merkt sich der Tab;
  // Ziel ist die Startseite oder (Rückfall) die Anmeldung bei Keycloak. Andere Tabs bleiben in ihrer Organisation.
  const switchOrg = useCallback(async (alias: string) => {
    try {
      const r = await authFetch('/auth/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org: alias, returnTo: config.paths.home }) });
      // 401: «Sitzung abgelaufen» wie bei jeder Anfrage (11.1); 403: /auth/me neu prüfen
      if (!r.ok) { reportStatus(r.status); throw await errorFrom(r); }
      let p: Partial<SwitchResult> = {};
      try { p = (await r.json()) as SwitchResult; } catch { /* leer */ }
      const me = qc.getQueryData<Me>(iamKeys.me);
      if (me) writeTabOrg({ sub: me.person.subject, alias, name: orgName(me, alias) });
      qc.clear();
      window.location.assign(p.redirect ?? config.paths.home);
    } catch (e) {
      // 401 zeigt schon «Sitzung abgelaufen»
      if (!(e instanceof ApiError && e.status === 401)) toast.error(e, t('iam.session.switchFailed'));
    }
  }, [qc, toast, config.paths.home]);
  const logout = useCallback(async () => {
    let r: Response;
    try {
      r = await authFetch('/auth/logout', { method: 'POST' });
      // 401: Sitzung schon weg, Abmelden gilt; andere Fehler: Sitzung besteht noch, nichts lokal verwerfen
      if (!r.ok && r.status !== 401) throw await errorFrom(r);
    } catch (e) { toast.error(e, t('iam.session.logoutFailed')); return; }
    let target = config.paths.loggedOut;
    try { const j = (await r.json()) as { redirect?: string }; if (j.redirect && j.redirect !== '/') target = j.redirect; } catch { /* Weiterleitung lokal */ }
    writeTabOrg(null);
    config.onLogout?.();
    qc.clear();
    window.location.assign(target);
  }, [qc, config, toast]);

  const value = useMemo<IamSession | null>(() => (meQ.data ? makeSession(meQ.data, switchOrg, logout) : null), [meQ.data, switchOrg, logout]);

  if (loggedOut) return <LoggedOut />;
  if (signup) return <PublicPageBoundary><Suspense fallback={<div className="iam-gate"><Loading /></div>}><SignupPage /></Suspense></PublicPageBoundary>;
  if (entraPublic) {
    return (
      <PublicPageBoundary>
        <Suspense fallback={<div className="iam-gate"><Loading /></div>}>{entraPublic === 'handover' ? <HandoverPage token={handoverToken} /> : <HandoverReturn />}</Suspense>
      </PublicPageBoundary>
    );
  }
  if (meQ.isPending) return <div className="iam-gate"><Loading label={t('iam.session.checking')} /></div>;
  if (meQ.error && !meQ.data) {
    if (meQ.error instanceof ApiError && meQ.error.status === 401) {
      window.location.assign(loginUrl());
      return <div className="iam-gate"><Loading label={t('iam.session.redirecting')} /></div>;
    }
    return <div className="iam-gate"><ErrorState error={meQ.error} onRetry={() => void meQ.refetch()} /></div>;
  }
  const me = meQ.data!;
  const gone = unavailableOrg(me);
  if (gone) {
    // Nie stillschweigend in eine andere Organisation: die Person wählt selbst oder lädt neu (z. B. nach erneuter Aufnahme)
    const others = me.organizations.filter(o => o !== gone.alias);
    return (
      <Gate title={t('iam.org.unavailable.title')} text={t('iam.org.unavailable.text', { org: gone.name })}>
        {me.tenantError ? <p className="iam-muted iam-small">{me.tenantError}</p> : null}
        {others.length ? (
          <div className="iam-org-list" role="group" aria-label={t('iam.org.choose')}>
            {others.map(o => <Button key={o} icon="building" onClick={() => void switchOrg(o)}>{t('iam.org.switchTo', { org: orgName(me, o) })}</Button>)}
          </div>
        ) : null}
        <Button variant="primary" onClick={() => window.location.reload()}>{t('iam.org.reload')}</Button>
        <button type="button" className="iam-linkbtn" onClick={() => void logout()}>{t('iam.session.logout')}</button>
      </Gate>
    );
  }
  if (!me.tenant) {
    // Ohne Organisation im Tab (keine, mehrere ohne Wahl): Konto mit Auswahl, eigener Organisation und – mit der
    // Realm-Rolle – der Plattform-Administration, die auch ohne Organisation arbeitet (Kap. 6.3)
    const platform = platformRoute(config, pathname);
    return (
      <Suspense fallback={<div className="iam-gate"><Loading /></div>}>
        {platform ? <PlatformShell me={me} route={platform} logout={logout} /> : <AccountHome me={me} switchOrg={switchOrg} logout={logout} />}
      </Suspense>
    );
  }
  return (
    <Ctx.Provider value={value}>
      {/* Neu einhängen bei anderer Person oder Organisation: Komponenten der App zeigen nie Daten von vorher */}
      <Fragment key={scopeOf(me)}>{children}</Fragment>
      {expired ? (
        <Dialog title={t('iam.session.expired.title')} onClose={() => setExpired(false)} role="alertdialog" width={440} initialFocus="[data-confirm]" top
          footer={<><Button variant="ghost" onClick={() => setExpired(false)}>{t('iam.session.expired.later')}</Button><Button data-confirm variant="primary" href={loginUrl()}>{t('iam.session.login')}</Button></>}>
          <p>{t('iam.session.expired.text')}</p>
          <p className="iam-muted iam-small">{t('iam.session.expired.hint')}</p>
        </Dialog>
      ) : null}
    </Ctx.Provider>
  );
}

/** «Du bist abgemeldet»: öffentlich, ändert nichts; erneute Anmeldung erst auf Klick. */
export function LoggedOut() {
  const { product, paths, features } = useIamConfig();
  const { Button } = useIamUi();
  useEffect(() => { if (product) document.title = t('iam.loggedOut.docTitle', { product }); }, [product]);
  return (
    <Gate title={t('iam.loggedOut.title')} text={t('iam.loggedOut.text')}>
      <Button variant="primary" href={loginUrl(paths.home)}>{t('iam.session.login')}</Button>
      {features.signup ? <a className="iam-linkbtn" href={paths.signup}>{t('iam.loggedOut.signup')}</a> : null}
    </Gate>
  );
}

/** Öffentliche Seite liess sich nicht laden (z. B. Chunk): Hinweis statt leerer Seite; das Token ist schon aus der Adresse. */
class PublicPageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <Gate title={t('iam.handover.title')} text={t('iam.handover.loadFailed')} /> : this.props.children; }
}

/** Karte für Anmeldung, Auswahl und Abmeldung mit der Marke der App. */
export function Gate({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  const { product, brand } = useIamConfig();
  return (
    <main className="iam-gate">
      <div className="iam-gate-card">
        {brand ?? (product ? <div className="iam-brand"><span className="iam-bt">{product}</span></div> : null)}
        <h1>{title}</h1><p className="iam-muted">{text}</p>{children}
      </div>
    </main>
  );
}

/** Sitzung mit Person, Organisation und Rechten; nur innerhalb von `IamProvider` (bzw. `StaticIam` in Tests). */
/** Sitzung, falls vorhanden (für Bausteine, die auch ohne Sitzung funktionieren). */
export const useIamMaybe = (): IamSession | null => useContext(Ctx);

export function useIam(): IamSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('IamProvider fehlt');
  return s;
}

/** Nur anzeigen, wenn das Recht (auf Ebene der Organisation) vorhanden ist. */
export function Can({ perm, children, fallback = null }: { perm: Permission; children: ReactNode; fallback?: ReactNode }) {
  return useIam().can(perm) ? <>{children}</> : <>{fallback}</>;
}

/** Feste Sitzung ohne Server (Testhilfe, Vorschau): Organisation und CSRF wie nach /auth/me. */
export function StaticSession({ me, children }: { me: Me; children: ReactNode }) {
  const config = useIamConfig();
  const value = useMemo<IamSession>(() => { applyMe(me, config); return makeSession(me, async () => {}, async () => {}); }, [me, config]);
  useEffect(() => { setCsrfToken(me.csrfToken); return () => setCsrfToken(null); }, [me.csrfToken]);
  useEffect(() => () => { setTenant(null); }, []);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
