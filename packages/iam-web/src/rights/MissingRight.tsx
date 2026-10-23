/**
 * Hinweis auf ein fehlendes Recht, überall gleich (Spezifikation 11.2): Recht mit Label aus dem Katalog, die Rollen, die
 * es enthalten, und wer Rollen vergibt, ergänzt um «oder jemand gibt dir an … frei» (Rollen, die an diesem Typ hängen
 * dürfen und das Recht enthalten, `place`). Scheitert es an der Vertraulichkeit (`classification` über der eigenen
 * Freigabestufe), Stufe und eigene Freigabestufe. Kompakt als Satz unter einer Aktion oder als ganze Seite «Recht fehlt»
 * (auch für die Guards). Der Schlüssel erscheint nur als technischer Zusatz (title). Statt eines Rechts kann die
 * Plattform-Administration fehlen (`PLATFORM_ADMIN`). Herkunft: vollholz/assets `web/src/ui/MissingRight.tsx`.
 */
import type { ReactNode } from 'react';
import { useAuthz, type Authz } from '../authz.ts';
import type { Level } from '../contract.ts';
import { ADMIN_ROLE, ORG_TYPE, PLATFORM_ADMIN, type Permission } from '../permissions.ts';
import { useIamMaybe } from '../session.tsx';
import { listAnd, listOr, t } from '../texts/index.ts';
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
 * «Oder jemand gibt dir an «Projekte» die Rolle «Bearbeiter:in» frei.»: Rollen, die am Typ hängen dürfen und das Recht
 * enthalten (ohne org-admin, das nur an der Organisation hängt); leer, wenn es keine gibt oder der Ort die Organisation ist.
 */
export function missingPlaceText(authz: Authz, perm: Permission, type: string, label: string): string {
  if (type === ORG_TYPE) return '';
  const at = new Set(authz.type(type)?.roles ?? []);
  const roles = authz.rolesWith(perm).filter(r => r.key !== ADMIN_ROLE && at.has(r.key)).map(r => r.label);
  if (!roles.length) return '';
  return roles.length === 1 ? t('iam.missing.placeRole', { label, role: roles[0]! }) : t('iam.missing.placeRoles', { label, roles: listOr(quoted(roles)) });
}

/** Ort, an dem die Aktion scheitert (`type` aus dem Modell, `label` Name des Orts). */
export interface MissingPlace { type: string; label: string }

/**
 * Satz unter einer Aktion; mit `page` als Leerzustand «Recht fehlt» (unter einem eigenen Seitenkopf). Solange der Katalog
 * lädt, ein Ladezustand statt des Satzes: ohne Katalog fehlten Label und Rollen, und wer die Rolle vergibt, wäre falsch.
 */
export function MissingRight({ perm, lead, page, place, classification, children }: {
  perm: Need; lead?: string; page?: boolean; place?: MissingPlace;
  /** Vertraulichkeit der Ressource: liegt sie über der eigenen Freigabestufe, nennt der Satz beide statt der Rollen. */
  classification?: Level;
  children?: ReactNode;
}) {
  const authz = useAuthz();
  const own = useIamMaybe()?.me.clearance ?? 0;
  if (perm !== PLATFORM_ADMIN && !authz.catalog) return page ? <Empty icon="shield" title={t('iam.missing.title')}><Loading inline /></Empty> : <Loading inline />;
  const text = classification !== undefined && classification > own
    ? t('iam.missing.clearance', { level: authz.classificationLabel(classification), own: authz.classificationLabel(own) })
    : [missingRightText(authz, perm, lead), perm !== PLATFORM_ADMIN && place ? missingPlaceText(authz, perm, place.type, place.label) : ''].filter(Boolean).join(' ');
  const tech = perm === PLATFORM_ADMIN ? t('iam.missing.platformTech') : perm;
  if (page) return <Empty icon="shield" title={t('iam.missing.title')}><p title={tech}>{text}</p>{children}</Empty>;
  return <p className="iam-muted iam-small iam-missing-right" title={tech}>{text}{children ? <> {children}</> : null}</p>;
}

/** Ganze Verwalten-Seite ohne Recht: Kopf mit Titel und Hinweis. Für die Guards (`Requires`, `RequiresPlatformAdmin`). */
export function NoPermission({ perm, icon, title }: { perm: Need; icon: string; title: string }) {
  return <><AdminHead icon={icon} title={title} /><div className="iam-body"><div className="iam-int"><MissingRight perm={perm} page /></div></div></>;
}
