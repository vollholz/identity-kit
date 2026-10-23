/**
 * Hinweis auf ein fehlendes Recht, überall gleich (Spezifikation 11.2): Recht mit Label aus dem Katalog, die Rollen, die
 * es enthalten, und wer Rollen vergibt. Kompakt als Satz unter einer Aktion oder als ganze Seite «Recht fehlt» (auch für
 * die Guards). Der Schlüssel erscheint nur als technischer Zusatz (title). Statt eines Rechts kann die
 * Plattform-Administration fehlen (`PLATFORM_ADMIN`). Herkunft: vollholz/assets `web/src/ui/MissingRight.tsx`.
 */
import type { ReactNode } from 'react';
import { useAuthz, type Authz } from '../authz.ts';
import { PLATFORM_ADMIN, type Permission } from '../permissions.ts';
import { listAnd, t } from '../texts/index.ts';
import { Empty, Loading } from '../ui/states.tsx';
import { AdminHead } from './AdminHead.tsx';

/** Recht des Katalogs oder die Realm-Rolle `platform-admin` (Plattform-Administration). */
export type Need = Permission | typeof PLATFORM_ADMIN;

const quoted = (xs: string[]) => xs.map(x => `«${x}»`);

/**
 * Text des Hinweises. `lead` ersetzt «Dafür» (z. B. «Zum Entscheiden»). Ohne geladenen Katalog fehlt der Satz zu den
 * Rollen. Beispiel: «Dafür fehlt dir das Recht «Notizen ändern». Es gehört zu den Rollen «Bearbeiter:in» und
 * «Organisations-Admin». Rollen vergibt die Organisations-Administration.»
 */
export function missingRightText(authz: Authz, perm: Need, lead = t('iam.missing.lead')): string {
  if (perm === PLATFORM_ADMIN) return t('iam.missing.platform', { lead });
  const with_ = authz.rolesWith(perm), roles = with_.map(r => r.label);
  const who = !roles.length ? '' : roles.length === 1 ? ` ${t('iam.missing.onlyRole', { role: roles[0]! })}` : ` ${t('iam.missing.roles', { roles: listAnd(quoted(roles)) })}`;
  // Nur org-admin (adminOnly): diese Rolle vergibt die Plattform-Administration, nicht die Organisation selbst
  const by = with_.length && with_.every(r => r.adminOnly) ? t('iam.missing.byPlatform') : t('iam.missing.byOrg');
  return `${t('iam.missing.sentence', { lead, label: authz.permLabel(perm) })}${who} ${by}`;
}

/**
 * Satz unter einer Aktion; mit `page` als Leerzustand «Recht fehlt» (unter einem eigenen Seitenkopf). Solange der Katalog
 * lädt, ein Ladezustand statt des Satzes: ohne Katalog fehlten Label und Rollen, und wer die Rolle vergibt, wäre falsch.
 */
export function MissingRight({ perm, lead, page, children }: { perm: Need; lead?: string; page?: boolean; children?: ReactNode }) {
  const authz = useAuthz();
  if (perm !== PLATFORM_ADMIN && !authz.catalog) return page ? <Empty icon="shield" title={t('iam.missing.title')}><Loading inline /></Empty> : <Loading inline />;
  const text = missingRightText(authz, perm, lead);
  const tech = perm === PLATFORM_ADMIN ? t('iam.missing.platformTech') : perm;
  if (page) return <Empty icon="shield" title={t('iam.missing.title')}><p title={tech}>{text}</p>{children}</Empty>;
  return <p className="iam-muted iam-small iam-missing-right" title={tech}>{text}{children ? <> {children}</> : null}</p>;
}

/** Ganze Verwalten-Seite ohne Recht: Kopf mit Titel und Hinweis. Für die Guards (`Requires`, `RequiresPlatformAdmin`). */
export function NoPermission({ perm, icon, title }: { perm: Need; icon: string; title: string }) {
  return <><AdminHead icon={icon} title={title} /><div className="iam-body"><div className="iam-int"><MissingRight perm={perm} page /></div></div></>;
}
