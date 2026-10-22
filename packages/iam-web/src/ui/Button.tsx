/**
 * Knopf der Bausteine (Vertrag für `components.Button`). Mit `href` ein Link in Knopfform. `busy` sperrt per
 * `aria-disabled`: der Knopf bleibt fokussierbar (der Fokus bleibt im Dialog), Klicks wirken nicht.
 */
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';
import type { IamIconName } from './icons.ts';
import { useIamUi } from './context.tsx';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'danger-solid';

interface Common {
  variant?: ButtonVariant;
  size?: 'sm';
  /** Symbol vor dem Text. */
  icon?: IamIconName;
  busy?: boolean;
  children?: ReactNode;
}
export type ButtonProps = Common & (
  | ({ href?: undefined; ref?: Ref<HTMLButtonElement> } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>)
  | ({ href: string; ref?: Ref<HTMLAnchorElement> } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'>)
);

const VARIANT: Record<ButtonVariant, string> = {
  default: '', primary: ' iam-primary', ghost: ' iam-ghost', danger: ' iam-danger', 'danger-solid': ' iam-danger iam-solid',
};

/** Klassen eines Knopfs (auch für Elemente, die selbst Knöpfe sind, z. B. der Auslöser eines Menüs). */
export const buttonClass = (variant: ButtonVariant = 'default', size?: 'sm', extra?: string) =>
  `iam-btn${VARIANT[variant]}${size ? ` iam-${size}` : ''}${extra ? ` ${extra}` : ''}`;

export function Button(props: ButtonProps) {
  const { Icon } = useIamUi();
  const { variant, size, icon, busy, children, className, ...rest } = props;
  const cls = buttonClass(variant, size, className);
  const content = <>{icon ? <Icon name={icon} className="iam-ico" /> : null}{children}</>;
  if (rest.href !== undefined) {
    const { ref, onClick, ...a } = rest as AnchorHTMLAttributes<HTMLAnchorElement> & { ref?: Ref<HTMLAnchorElement> };
    // gesperrter Link: bleibt fokussierbar, navigiert aber nicht
    return (
      <a ref={ref} className={cls} {...a} aria-disabled={busy || a['aria-disabled'] || undefined}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => { if (busy) { e.preventDefault(); return; } onClick?.(e); }}>{content}</a>
    );
  }
  const { ref, type = 'button', onClick, ...b } = rest as ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> };
  return (
    <button ref={ref} type={type} className={cls} {...b} aria-disabled={busy || b['aria-disabled'] || undefined}
      onClick={(e: MouseEvent<HTMLButtonElement>) => { if (busy) { e.preventDefault(); return; } onClick?.(e); }}>
      {content}
    </button>
  );
}
