/**
 * Tabelle der Bausteine (Vertrag für `components.Table`): nur das `<table>`-Element mit Rahmenklassen, Inhalt schreibt
 * die Seite selbst. `stack`: unter 760 px gestapelt (je Zeile Felder untereinander, Spaltenköpfe nur für Screenreader);
 * Zellen mit `iam-st-hide` fallen dann weg, `iam-st-lbl` beschriftet Zellen ohne sichtbaren Kopf.
 */
import type { TableHTMLAttributes } from 'react';

export type TableProps = TableHTMLAttributes<HTMLTableElement> & { stack?: boolean };

export function Table({ stack, className, ...rest }: TableProps) {
  return <table className={`iam-tbl${stack ? ' iam-stack-tbl' : ''}${className ? ` ${className}` : ''}`} {...rest} />;
}
