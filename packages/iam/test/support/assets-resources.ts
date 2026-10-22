/**
 * Ressourcen-Modell wie Assets (Kette tenant → schema → type… → object; connection und credential direkt unter dem
 * Mandanten), nur mit dem Zustand im Speicher: zeigt, dass die Entscheidung von Assets mit `ResourceModel` gleich bleibt.
 */
import { flatChain, type ResourceModel, type ResourceRef } from '../../src/resources.ts';

export interface AssetsState { typeSchema: Map<string, string>; typeParent: Map<string, string | null> }

export const assetsResources: ResourceModel<AssetsState> = {
  chain(s, r, objectTypeId) {
    if (r.type === 'tenant' || r.type === 'connection' || r.type === 'credential') return flatChain(r);
    const out: ResourceRef[] = [{ type: 'tenant' }];
    let typeId = r.type === 'type' ? r.id ?? null : r.type === 'object' ? objectTypeId ?? null : null;
    const schemaId = r.type === 'schema' ? r.id ?? null : typeId ? s.typeSchema.get(typeId) ?? null : null;
    if (schemaId) out.push({ type: 'schema', id: schemaId });
    const types: string[] = [];
    while (typeId) { types.unshift(typeId); typeId = s.typeParent.get(typeId) ?? null; }
    for (const t of types) out.push({ type: 'type', id: t });
    if (r.type === 'object' && r.id) out.push(r);
    return out;
  },
  exists: async () => true,
};
