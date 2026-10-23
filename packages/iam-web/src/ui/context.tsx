/**
 * Austauschbare Grundkomponenten (docs/entwurf.md › Grundkomponenten): Die App ersetzt Knopf, Dialog, Menü, Tabelle,
 * Symbol und Meldungen durch eigene; ohne Angabe gelten die des Pakets. Verhalten (Fokus, Tastatur, ARIA) gehört zum
 * Vertrag jeder Komponente. `IamProvider` setzt den Kontext; einzeln nutzbar mit `IamUiProvider` (Tests, Storybook).
 */
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import { Button, type ButtonProps } from './Button.tsx';
import { Icon, type IconProps } from './Icon.tsx';
import { MenuButton, type MenuButtonProps } from './MenuButton.tsx';
import { Modal, type ModalProps } from './Overlay.tsx';
import { Table, type TableProps } from './Table.tsx';
import { ToastHost, useToastHost, type ToastApi } from './Toasts.tsx';

export interface IamComponents {
  Button: ComponentType<ButtonProps>;
  Dialog: ComponentType<ModalProps>;
  Menu: ComponentType<MenuButtonProps>;
  Table: ComponentType<TableProps>;
  Icon: ComponentType<IconProps>;
  /** Meldungen; ohne Angabe zeigt das Paket eigene (unten in der Mitte, `aria-live`). */
  toast: ToastApi;
}

const DEFAULTS: Omit<IamComponents, 'toast'> = { Button, Dialog: Modal, Menu: MenuButton, Table, Icon };

const Ctx = createContext<IamComponents | null>(null);

export function IamUiProvider({ components, children }: { components?: Partial<IamComponents>; children: ReactNode }) {
  const host = useToastHost();
  const toast = components?.toast;
  const value = useMemo<IamComponents>(() => ({ ...DEFAULTS, ...components, toast: toast ?? host.api }), [components, toast, host.api]);
  return <Ctx.Provider value={value}>{children}{toast ? null : <ToastHost host={host} />}</Ctx.Provider>;
}

/** Grundkomponenten; ausserhalb eines Providers die des Pakets (Meldungen dann ohne Anzeige). */
export function useIamUi(): IamComponents {
  return useContext(Ctx) ?? FALLBACK;
}

const FALLBACK: IamComponents = { ...DEFAULTS, toast: { show: () => {}, error: () => {} } };
