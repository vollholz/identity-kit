/**
 * Rollenmatrix (Spezifikation 11.2): Rechtegruppen × Rollen, je Zelle alle, ein Teil oder keine Rechte der Gruppe. Gruppen,
 * Zuordnung und Labels aus dem Katalog; die Rollen übergibt der Aufrufer, gezeigt in der Reihenfolge des Rollendialogs
 * (`groupRoles`), mit Trennlinie zwischen den Rollengruppen. Jede Gruppe aufklappbar (je Recht ✓ / –). Ohne waagrechtes
 * Scrollen bis auf Handybreite: Rollen als senkrechte Spaltenköpfe, «teilweise» als Zahl. `RoleCompare`: eingeklappt als
 * «Rollen vergleichen».
 */
import { Fragment, useState } from 'react';
import { useAuthz } from '../authz.ts';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { Loading } from '../ui/states.tsx';

interface MatrixRole { key: string; label: string; permissions: readonly string[] }

/** Hervorgehobene Rollen, nur direkt vergebene: eigene («Meine Rollen und Rechte») oder die gewählten (Rollendialog). */
const MARK = { mine: ['iam.matrix.mine', 'iam.matrix.mineOne'], selected: ['iam.matrix.selected', 'iam.matrix.selectedOne'] } as const;

export interface RoleMatrixProps { roles: MatrixRole[]; highlight?: string[]; highlightAs?: keyof typeof MARK; caption?: string }

/** «Rollen vergleichen»: die Matrix eingeklappt; `open` nur für Ansichten, in denen der Vergleich Hauptsache ist. */
export function RoleCompare({ open, ...props }: RoleMatrixProps & { open?: boolean }) {
  useIamText();
  return (
    <details className="iam-more iam-role-compare" open={open}>
      <summary>{t('iam.matrix.compare')}</summary>
      <RoleMatrix {...props} />
    </details>
  );
}

export function RoleMatrix({ roles, highlight = [], highlightAs = 'mine', caption }: RoleMatrixProps) {
  const authz = useAuthz();
  const { Icon } = useIamUi();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const cat = authz.catalog;
  if (!cat) return <Loading inline />;
  const mine = new Set(highlight);
  // Rollen wie im Rollendialog geordnet; `sep` markiert die erste Rolle jeder weiteren Gruppe
  const cols = authz.groupRoles(roles).flatMap((g, gi) => g.roles.map((r, i) => ({ ...r, sep: gi > 0 && i === 0 })));
  const groups = cat.groups.map(g => ({ ...g, perms: cat.permissions.filter(p => p.group === g.key) })).filter(g => g.perms.length);
  const toggle = (key: string) => setOpen(s => { const n = new Set(s); if (!n.delete(key)) n.add(key); return n; });
  const cls = (r: { key: string; sep: boolean }, base = '') => [base, mine.has(r.key) ? 'iam-mine' : '', r.sep ? 'iam-rm-sep' : ''].filter(Boolean).join(' ') || undefined;
  const check = <Icon name="check" className="iam-ico" />;
  return (
    <div className="iam-role-matrix">
      <table className="iam-tbl">
        <caption className="iam-sr">{caption ?? t('iam.matrix.caption')}{mine.size ? ` (${t(MARK[highlightAs][0])})` : ''}</caption>
        <thead>
          <tr>
            <th scope="col" className="iam-rm-g">{t('iam.matrix.group')}</th>
            {cols.map(r => <th key={r.key} scope="col" className={cls(r, 'iam-rm-role')}><span>{r.label}</span>{mine.has(r.key) ? <span className="iam-sr"> ({t(MARK[highlightAs][1])})</span> : null}</th>)}
          </tr>
        </thead>
        <tbody>
          {groups.map(g => {
            const expanded = open.has(g.key);
            return (
              <Fragment key={g.key}>
                <tr className={expanded ? 'iam-rm-open' : undefined}>
                  <th scope="row" className="iam-rm-g">
                    <button type="button" className="iam-rm-tg" aria-expanded={expanded} onClick={() => toggle(g.key)}>{g.label}</button>
                  </th>
                  {cols.map(r => {
                    const has = g.perms.filter(p => r.permissions.includes(p.key));
                    const all = has.length === g.perms.length, none = !has.length;
                    const names = has.map(p => authz.permLabel(p.key)).join(', ');
                    return (
                      <td key={r.key} className={cls(r, `iam-rm-${all ? 'all' : none ? 'none' : 'some'}`)} title={none ? t('iam.matrix.noneTitle') : names}>
                        {all ? <>{check}<span className="iam-sr">{t('iam.matrix.all', { names })}</span></>
                          : none ? <><span aria-hidden="true">–</span><span className="iam-sr">{t('iam.matrix.none')}</span></>
                            : <><span aria-hidden="true">{has.length}/{g.perms.length}</span><span className="iam-sr">{t('iam.matrix.some', { names })}</span></>}
                      </td>
                    );
                  })}
                </tr>
                {expanded ? g.perms.map(p => (
                  <tr key={p.key} className="iam-rm-perm">
                    <th scope="row" className="iam-rm-g">{authz.permLabel(p.key)}</th>
                    {cols.map(r => {
                      const yes = r.permissions.includes(p.key);
                      return (
                        <td key={r.key} className={cls(r, yes ? 'iam-rm-all' : 'iam-rm-none')}>
                          {yes ? <>{check}<span className="iam-sr">{t('iam.matrix.yes')}</span></> : <><span aria-hidden="true">–</span><span className="iam-sr">{t('iam.matrix.no')}</span></>}
                        </td>
                      );
                    })}
                  </tr>
                )) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
