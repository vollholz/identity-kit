/**
 * Hinweis «Zugriff eingeschränkt (n)» an einer Ressource der App für Personen mit `acl:read`, mit Link auf die danach
 * gefilterte Zugriffsseite. Mit `resources.useChain` zählen auch die Einträge auf den Stufen darüber mit («1 hier,
 * 3 von «Projekte»»); Einträge auf Organisationsebene nicht, die gelten überall. Ohne Einträge oder Recht: nichts.
 * Herkunft: vollholz/assets `web/src/features/acl/AclHint.tsx`, Kette über den Adapter statt Schema und Objekttyp.
 */
import { useIamConfig } from '../config.tsx';
import { useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { buttonClass } from '../ui/Button.tsx';
import { useIamUi } from '../ui/context.tsx';
import { hintCounts, type HintStage } from './rules.ts';
import { useAclEntries } from './shared.tsx';

/** Ohne Kette des Adapters keine Stufen darüber. */
const noChain = () => [];

export function AclHint({ resourceType, resourceId }: { resourceType: string; resourceId: string }) {
  const { can } = useIam();
  const { paths, resources, router: { Link } } = useIamConfig();
  const { Icon } = useIamUi();
  useIamText();
  const allowed = can('acl:read');
  const q = useAclEntries(allowed);
  const chain = (resources?.useChain ?? noChain)(resourceType, resourceId);
  if (!allowed || !q.data || !chain) return null;
  const stages: HintStage[] = [
    ...chain.map(s => ({ type: s.type, id: s.id, text: t('iam.acl.hint.from', { name: s.label }) })),
    { type: resourceType, id: resourceId, text: t('iam.acl.hint.here') },
  ];
  const counts = hintCounts(q.data, stages);
  if (!counts.length) return null;
  const own = counts.find(c => c.id === resourceId && c.type === resourceType);
  // Link auf die Stufe mit Einträgen: die Ressource selbst, sonst die nächste übergeordnete
  const target = own ?? counts[counts.length - 1]!;
  const label = counts.length === 1 && own ? String(own.count) : [...counts].reverse().map(c => `${c.count} ${c.text}`).join(', ');
  const search = new URLSearchParams({ resourceType: target.type, resourceId: target.id });
  return (
    <Link to={`${paths.access}?${search}`} className={buttonClass('ghost', 'sm')} title={t('iam.acl.hint.title')}>
      <Icon name="shield" className="iam-ico" />{t('iam.acl.hint.label', { label })}
    </Link>
  );
}
