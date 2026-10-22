/** Rendern mit den Grundkomponenten des Pakets (oder ersetzten) und axe ohne Farbprüfung (jsdom kennt keine Farben). */
import { render } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { IamUiProvider, type IamComponents } from '../src/index.ts';

export function renderUi(ui: ReactElement, components?: Partial<IamComponents>) {
  return render(<IamUiProvider components={components}>{ui}</IamUiProvider>);
}

/** Verstösse ab «serious» (Spezifikation 11.3: axe ohne serious/critical). */
export async function axeProblems(root: Element = document.body): Promise<string[]> {
  const r = await axe.run(root, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
}
