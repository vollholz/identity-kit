/** Texte in React: Komponenten mit `useIamText()` zeichnen neu, wenn Sprache oder Texte wechseln. */
import { createContext, useContext } from 'react';
import { currentLocale, t, tn, type IamLocale } from './index.ts';

interface TextState { locale: IamLocale; version: number }

const Ctx = createContext<TextState | null>(null);
export const IamTextProvider = Ctx.Provider;

export function useIamText() {
  const s = useContext(Ctx);
  return { t, tn, locale: s?.locale ?? currentLocale() };
}
