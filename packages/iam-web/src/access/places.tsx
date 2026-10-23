/**
 * Orte anzeigen (Spezifikation 11.4): Namen kennt nur die App (`resources.useResolver`), die Antworten von `/v1/access`
 * liefern keine. Ein Ort heisst «<Typ> «<Name>»» (z. B. Ordner «Projekte»), die Organisation nur «Organisation»; ohne
 * Namen «<Typ> (nicht sichtbar)». Der Pfeil zum Ort erscheint nur, wenn die App `resources.open` liefert.
 */
import { useAuthz } from '../authz.ts';
import { useIamConfig } from '../config.tsx';
import type { ResourceRef } from '../contract.ts';
import { ORG_TYPE } from '../permissions.ts';
import { t } from '../texts/index.ts';
import { useIamUi } from '../ui/context.tsx';

/** Name eines Orts als Satzteil; die Organisation ohne Namen («Organisation»). */
export function usePlaceName(): (ref: ResourceRef) => string {
  const { resources } = useIamConfig();
  const authz = useAuthz();
  const resolver = resources?.useResolver();
  return ref => {
    if (ref.type === ORG_TYPE) return authz.typeLabel(ORG_TYPE);
    const name = resolver?.name(ref);
    const type = authz.typeLabel(ref.type);
    return name ? t('iam.access.place', { type, name }) : t('iam.access.placeHidden', { type });
  };
}

/** Pfeil «Zu <Ort>» (öffnet den Ort in der App); ohne `resources.open` nichts. */
export function OpenPlace({ place, label }: { place: ResourceRef; label: string }) {
  const { resources } = useIamConfig();
  const { Icon } = useIamUi();
  if (!resources?.open) return null;
  const open = resources.open;
  return (
    <button type="button" className="iam-iconbtn iam-sm" aria-label={t('iam.access.open', { place: label })} title={t('iam.access.open', { place: label })} onClick={() => open(place)}>
      <Icon name="arrow" className="iam-ico" />
    </button>
  );
}
