/**
 * Kontomenü (Spezifikation 11.1, 11.2): Person, Organisation und Rollen, «Meine Rollen und Rechte», Organisation
 * wechseln (für diesen Tab, ohne neue Anmeldung) und Abmelden; Menü-Button nach ARIA-Muster «Menu Button». Die App
 * liefert das Symbol des Knopfs (`avatar`) und eigene Einträge (`extraItems`, Buttons mit role="menuitem").
 * Herkunft: vollholz/assets `web/src/shell/UserMenu.tsx`.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useAuthz } from '../authz.ts';
import { orgName as nameOf, useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamUi } from '../ui/context.tsx';
import { MyRightsDialog } from './MyRights.tsx';

export interface AccountMenuProps {
  /** Inhalt des Knopfs, z. B. Initialen der Person. */
  avatar: ReactNode;
  /** Weitere Einträge vor «Abmelden»; `close` schliesst das Menü. */
  extraItems?: (close: () => void) => ReactNode;
  className?: string;
}

export function AccountMenu({ avatar, extraItems, className }: AccountMenuProps) {
  const { me, switchOrg, logout, orgName } = useIam();
  const { roleLabel } = useAuthz();
  const { Icon } = useIamUi();
  const [open, setOpen] = useState(false);
  const [rights, setRights] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  const groupId = useId();

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  const close = () => { setOpen(false); btn.current?.focus(); };
  const others = me.organizations.filter(o => o !== me.tenant?.alias);
  const name = me.person.name ?? me.person.email ?? '';
  return (
    <div className={`iam-usermenu${className ? ` ${className}` : ''}`}>
      <button ref={btn} type="button" className="iam-iconbtn" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(o => !o)}
        title={t('iam.account.title', { name: me.person.name ?? '', org: orgName })}>
        {/* Name als Text statt aria-label: der zugängliche Name enthält, was der Knopf zeigt (axe label-content-name-mismatch) */}
        {avatar}<span className="iam-sr">{t('iam.account.sr', { name, org: orgName })}</span>
      </button>
      {open ? (
        <div ref={ref} id={id} className="iam-menu" role="menu" aria-label={t('iam.account.menu')} onKeyDown={onKey} tabIndex={-1}>
          <div className="iam-menu-h">
            <b>{me.person.name}</b>
            <span className="iam-muted iam-small">{me.person.email}</span>
            <span className="iam-muted iam-small">{t('iam.account.org')} <b title={me.tenant?.alias}>{orgName}</b> · {me.roles.map(roleLabel).join(', ') || t('iam.account.noRole')}</span>
          </div>
          <button type="button" role="menuitem" className="iam-menu-i" onClick={() => { setOpen(false); setRights(true); }}><Icon name="shield" className="iam-ico" />{t('iam.myRights.title')}</button>
          {others.length ? (
            <>
              <div className="iam-menu-g" id={groupId} role="presentation">{t('iam.account.switch')}</div>
              <div role="group" aria-labelledby={groupId}>
                {others.map(o => <button key={o} type="button" role="menuitem" className="iam-menu-i" onClick={() => void switchOrg(o)}><Icon name="building" className="iam-ico" />{t('iam.org.switchTo', { org: nameOf(me, o) })}</button>)}
              </div>
            </>
          ) : null}
          {extraItems ? extraItems(close) : null}
          <div className="iam-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="iam-menu-i" onClick={() => void logout()}><Icon name="x" className="iam-ico" />{t('iam.session.logout')}</button>
        </div>
      ) : null}
      {rights ? <MyRightsDialog onClose={() => { setRights(false); btn.current?.focus(); }} /> : null}
    </div>
  );
}
