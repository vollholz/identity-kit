/**
 * Kopf der Verwalten-Seiten: Pfad (Produkt › Verwalten › …), Symbol, Titel, Untertitel, Hauptaktion. Links über
 * den Router-Adapter.
 */
import type { ReactNode } from 'react';
import { useIamConfig } from '../config.tsx';
import { t } from '../texts/index.ts';
import { useIamUi } from '../ui/context.tsx';
import type { IamIconName } from '../ui/icons.ts';

export interface AdminHeadProps {
  /** Symbol der Seite (Name aus `IamIconName` oder der App, wenn sie `components.Icon` setzt). */
  icon: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  /** Zwischenstufen [Label, Pfad] zwischen «Verwalten» und dem Titel. */
  crumbs?: [string, string][];
  children?: ReactNode;
}

export function AdminHead({ icon, title, sub, actions, crumbs = [], children }: AdminHeadProps) {
  const { product, paths, router: { Link } } = useIamConfig();
  const { Icon } = useIamUi();
  const chev = <Icon name="chev" className="iam-ico" />;
  return (
    <div className={`iam-mh${children ? '' : ' iam-pb'}`}>
      <nav className="iam-crumbs" aria-label={t('iam.admin.path')}>
        {product ? <><Link to={paths.home}>{product}</Link>{chev}</> : null}<span>{t('iam.admin.crumb')}</span>
        {crumbs.map(([l, to]) => <span key={to} className="iam-crumb">{chev}<Link to={to}>{l}</Link></span>)}
        {chev}<span>{title}</span>
      </nav>
      <div className="iam-mh-row">
        <div className="iam-mh-title"><div className="iam-type-ico iam-neutral"><Icon name={icon as IamIconName} className="iam-ico" /></div><div className="iam-minw0"><h1>{title}</h1>{sub ? <div className="iam-sub">{sub}</div> : null}</div></div>
        {actions ? <div className="iam-acts">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
