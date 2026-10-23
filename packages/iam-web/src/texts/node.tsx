/** Platzhalter mit React-Elementen ersetzen, z. B. `formatNode(t('iam.rights.why.scopeOk'), { scope: <span title=…>…</span> })`. */
import { Fragment, type ReactNode } from 'react';

export function formatNode(text: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/\{(\w+)\}/);
  return parts.map((p, i) => (i % 2 ? <Fragment key={i}>{p in vars ? vars[p] : `{${p}}`}</Fragment> : p));
}
