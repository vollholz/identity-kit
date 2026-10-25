/**
 * Enthaltensein von Rollen (aus den Rechten abgeleitet, nicht fest verdrahtet): Rolle A enthält B, wenn die Rechte von B
 * eine echte Teilmenge der Rechte von A sind. Rollen ohne Rechte enthält keine.
 */

interface RoleRights { key: string; permissions: readonly string[] }

/** Je Rolle die Rollen, die sie vollständig enthalten (echte Obermenge der Rechte). */
export function containers(roles: readonly RoleRights[]): Map<string, string[]> {
  const sets = new Map(roles.map(r => [r.key, new Set(r.permissions)]));
  const out = new Map<string, string[]>();
  for (const r of roles) {
    const mine = sets.get(r.key)!;
    if (!mine.size) { out.set(r.key, []); continue; }
    out.set(r.key, roles.filter(o => {
      const theirs = sets.get(o.key)!;
      return o.key !== r.key && theirs.size > mine.size && [...mine].every(p => theirs.has(p));
    }).map(o => o.key));
  }
  return out;
}

/** Ausgewählte Rollen, in denen `key` enthalten ist (leer: nicht enthalten). */
export function includedIn(key: string, selected: ReadonlySet<string>, map: Map<string, string[]>): string[] {
  return (map.get(key) ?? []).filter(k => selected.has(k));
}
