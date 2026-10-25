/**
 * Organisation dieses Tabs (Spezifikation 11.1): liegt im sessionStorage, gilt damit je Tab und bleibt beim Neuladen
 * erhalten. Mit der Person (`sub`): Nach einer Anmeldung als andere Person im selben Tab gilt die frühere Wahl nicht
 * (`tabOrgFor`). Mit dem Namen, damit der Hinweis «nicht mehr verfügbar» die Organisation auch dann nennt, wenn sie nicht
 * mehr im Token steht. Ohne Speicher (gesperrt, privates Fenster) gilt die Wahl bis zum Neuladen.
 * Eine App mit eigenem früherem Schlüssel übernimmt dessen Wert einmalig über `legacyKey`.
 */
export interface TabOrg { sub: string; alias: string; name?: string }

export const TAB_ORG_KEY = 'iam.tab.org';

// Der Speicher eines Tabs wechselt nie: einmal bestimmen (Tests bilden so mehrere Tabs nach)
const store: Storage | null = (() => { try { return globalThis.sessionStorage ?? null; } catch { return null; } })();
let memoryOnly = !store;
let memory: TabOrg | null = null;

function parse(raw: string | null): TabOrg | null {
  try {
    const v = raw ? JSON.parse(raw) as Partial<TabOrg> | null : null;
    return typeof v?.sub === 'string' && typeof v.alias === 'string' ? { sub: v.sub, alias: v.alias, name: typeof v.name === 'string' ? v.name : undefined } : null;
  } catch { return null; }
}

/**
 * Früheren Schlüssel einmal übernehmen (Umstellung einer App auf das Paket, offene Tabs behalten ihre Organisation):
 * nur wenn unter `iam.tab.org` noch nichts liegt; der alte Eintrag wird danach gelöscht.
 */
export function adoptLegacyTabOrg(legacyKey: string | undefined) {
  if (!legacyKey || memoryOnly || legacyKey === TAB_ORG_KEY) return;
  try {
    const old = store!.getItem(legacyKey);
    if (old === null) return;
    if (store!.getItem(TAB_ORG_KEY) === null && parse(old)) store!.setItem(TAB_ORG_KEY, old);
    store!.removeItem(legacyKey);
  } catch { memoryOnly = true; }
}

export function readTabOrg(): TabOrg | null {
  if (!memoryOnly) {
    try { return parse(store!.getItem(TAB_ORG_KEY)); } catch { memoryOnly = true; }
  }
  return memory;
}

export function writeTabOrg(v: TabOrg | null) {
  memory = v;
  if (memoryOnly) return;
  try { if (v) store!.setItem(TAB_ORG_KEY, JSON.stringify(v)); else store!.removeItem(TAB_ORG_KEY); } catch { memoryOnly = true; }
}

/** Wahl des Tabs für diese Person; gehört sie einer anderen Person, wird sie verworfen (`null`). */
export function tabOrgFor(sub: string): TabOrg | null {
  const v = readTabOrg();
  if (v && v.sub !== sub) { writeTabOrg(null); return null; }
  return v;
}
