/**
 * Vertraulichkeit einer Ressource als Badge (Spezifikation 11.2): ab Stufe 1 in Listen, Kopf und Suche; Stufe 0
 * (intern) zeigt nichts. Label aus `catalog.classifications`.
 */
import { useAuthz } from '../authz.ts';
import type { Level } from '../contract.ts';
import { t } from '../texts/index.ts';
import { useIamUi } from '../ui/context.tsx';

export interface ClassificationBadgeProps { level: Level; className?: string }

export function ClassificationBadge({ level, className }: ClassificationBadgeProps) {
  const authz = useAuthz();
  const { Icon } = useIamUi();
  if (!level) return null;
  const label = authz.classificationLabel(level);
  return (
    <span className={`iam-pill iam-sm iam-nodot iam-cls iam-cls-${level}${className ? ` ${className}` : ''}`} title={t('iam.classification.title', { label })}>
      <Icon name="lock" className="iam-ico" /><span className="iam-sr">{t('iam.classification.sr')} </span>{label}
    </span>
  );
}
