import { ICONS, type IamIconName } from './icons.ts';

export interface IconProps { name: IamIconName; className?: string }

/** Symbol der Bausteine. Dekorativ (aria-hidden), die Beschriftung gehört an das umgebende Element. */
export function Icon({ name, className }: IconProps) {
  const d = ICONS[name] ?? ICONS.more;
  const cls = ['iam-ico', ...(className ?? '').split(' ').filter(c => c && c !== 'iam-ico')].join(' ');
  return <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: d }} />;
}
