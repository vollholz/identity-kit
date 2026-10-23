/**
 * Fehlendes Recht und Rollenmatrix: Labels und Rollen aus dem Katalog, keine Rohschlüssel im Text.
 * Aus vollholz/assets `web/src/ui/rights.test.tsx`, produktneutral (Notiz-App).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAuthz, MissingRight, missingRightText, PLATFORM_ADMIN, RoleMatrix, type IamConfig } from '../src/index.ts';
import { CATALOG, json, mockIamApi, StaticIam } from '../src/testing/index.tsx';

beforeEach(() => vi.stubGlobal('fetch', mockIamApi().fetch));
afterEach(() => vi.unstubAllGlobals());

const renderIam = (ui: ReactElement, config?: Partial<IamConfig>) => render(<StaticIam config={config}>{ui}</StaticIam>);

describe('Fehlendes Recht', () => {
  const authz = makeAuthz(CATALOG);

  it('nennt Label und alle Rollen mit dem Recht, org-admin zuletzt, und wer Rollen vergibt', () => {
    expect(missingRightText(authz, 'note:write')).toBe('Dafür fehlt dir das Recht «Notizen ändern». Es gehört zu den Rollen «Ordner-Admin», «Bearbeiter:in» und «Organisations-Admin». Rollen vergibt die Organisations-Administration. Für einzelne Bereiche kann sie es auch über eine Zugriffsregel freigeben.');
    expect(missingRightText(authz, 'note:delete', 'Zum Löschen')).toMatch(/^Zum Löschen fehlt dir das Recht «Notizen löschen»\. Es gehört zu den Rollen «Ordner-Admin» und «Organisations-Admin»\./);
  });

  it('Freigabe für einzelne Bereiche nur, wo eine Zugriffsregel unterhalb der Organisation wirkt und es Zugriffsregeln gibt', () => {
    // «Protokoll lesen» wirkt nur auf Ebene der Organisation: dafür hilft nur eine Rolle
    expect(missingRightText(authz, 'audit:read')).not.toContain('Zugriffsregel');
    // Ohne Zugriffsregeln im Katalog (kein acl:read): kein Hinweis auf Freigaben
    const noAcl = makeAuthz({ ...CATALOG, permissions: CATALOG.permissions.filter(p => !p.key.startsWith('acl:')) });
    expect(missingRightText(noAcl, 'note:write')).toMatch(/Rollen vergibt die Organisations-Administration\.$/);
  });

  it('Recht nur bei org-admin: nur diese Rolle, vergeben von der Plattform-Administration', () => {
    expect(missingRightText(authz, 'acl:admin')).toBe('Dafür fehlt dir das Recht «Zugriff verwalten». Es gehört nur zur Rolle «Organisations-Admin». Diese Rolle vergibt die Plattform-Administration.');
    expect(missingRightText(authz, 'members:admin')).toContain('nur zur Rolle «Organisations-Admin»');
  });

  it('ohne Katalog: Schlüssel statt Label, kein Satz zu Rollen', () => {
    expect(missingRightText(makeAuthz(undefined), 'note:write')).toBe('Dafür fehlt dir das Recht «note:write». Rollen vergibt die Organisations-Administration.');
  });

  it('solange der Katalog lädt: Ladezustand statt Schlüssel und statt eines falschen «Organisations-Administration»', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const api = mockIamApi({ 'GET /v1/authz/catalog': async () => { await gate; return json(CATALOG); } });
    vi.stubGlobal('fetch', api.fetch);
    renderIam(<MissingRight perm="members:admin" page />);
    expect(screen.getByRole('heading', { name: 'Recht fehlt' })).toBeInTheDocument();
    expect(screen.getByText('Wird geladen …')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('members:admin');
    expect(document.body).not.toHaveTextContent('Organisations-Administration');
    release();
    expect(await screen.findByText(/Diese Rolle vergibt die Plattform-Administration\.$/)).toBeInTheDocument();
  });

  it('kompakt als Satz, als Seite mit «Recht fehlt»; Schlüssel nur als title', async () => {
    const { unmount } = renderIam(<MissingRight perm="folder:admin" lead="Zum Anlegen" />);
    const p = await screen.findByText(/^Zum Anlegen fehlt dir das Recht «Ordner verwalten»/);
    expect(p).toHaveAttribute('title', 'folder:admin');
    expect(p).not.toHaveTextContent('folder:admin');
    unmount();
    const page = renderIam(<MissingRight perm="audit:read" page />);
    expect(screen.getByRole('heading', { name: 'Recht fehlt' })).toBeInTheDocument();
    expect(await screen.findByText(/«Protokoll lesen».*«Prüfer:in» und «Organisations-Admin»/)).toBeInTheDocument();
    page.unmount();
    // Statt eines Rechts die Plattform-Administration: gleiches Muster, Technik nur im title
    renderIam(<MissingRight perm={PLATFORM_ADMIN} page />);
    const text = screen.getByText(/^Dafür braucht es die Plattform-Administration\./);
    expect(text).toHaveAttribute('title', 'Realm-Rolle «platform-admin» in Keycloak');
    expect(text).not.toHaveTextContent('platform-admin');
  });
});

describe('Rollenmatrix', () => {
  it('Tabelle Rechtegruppe × Rolle: alle, teilweise, keine; eigene Rollen hervorgehoben', async () => {
    const roles = CATALOG.roles.filter(r => ['org-admin', 'editor', 'viewer'].includes(r.key));
    renderIam(<RoleMatrix roles={roles} highlight={['editor']} />);
    const table = await screen.findByRole('table', { name: 'Rechte je Rolle (deine Rollen hervorgehoben)' });
    expect(within(table).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['Rechtegruppe', 'Organisations-Admin', 'Bearbeiter:in (deine Rolle)', 'Leser:in']);
    // Kein eigener Scrollcontainer (Kopfzeile klebt im Dialog), daher auch kein zusätzlicher Tabstopp
    expect(screen.queryByRole('region')).toBeNull();
    expect(within(table).getAllByRole('rowheader').map(c => c.textContent)).toEqual(CATALOG.groups.map(g => g.label));
    const notes = within(table).getByRole('row', { name: /^Notizen/ });
    const [admin, editor, viewer] = within(notes).getAllByRole('cell');
    expect(admin).toHaveTextContent('alle: Notizen lesen, Notizen ändern, Notizen löschen, Ordner verwalten');
    expect(editor).toHaveClass('iam-rm-some', 'iam-mine');
    expect(editor).toHaveTextContent(/^2\/4teilweise: Notizen lesen, Notizen ändern$/);
    expect(viewer).toHaveAttribute('title', 'Notizen lesen');
    const members = within(table).getByRole('row', { name: /^Mitglieder und Rollen/ });
    expect(within(members).getAllByRole('cell')[1]).toHaveClass('iam-rm-none');
    expect(within(members).getAllByRole('cell')[1]).toHaveTextContent('keine');
    expect(table).not.toHaveTextContent(/note:read|org-admin/);
  });

  it('Rollen in der Reihenfolge des Rollendialogs (roleGroups der App), Trennlinie zwischen den Gruppen', async () => {
    const roleGroups = [
      { key: 'org', label: 'Gesamte Organisation', roles: ['org-admin'] },
      { key: 'work', label: 'Arbeit', roles: ['editor', 'viewer'] },
      { key: 'control', label: 'Kontrolle', roles: ['auditor'] },
    ];
    const { unmount } = renderIam(<RoleMatrix roles={CATALOG.roles} />);
    let cols = within(await screen.findByRole('table', { name: 'Rechte je Rolle' })).getAllByRole('columnheader').slice(1);
    expect(cols.map(c => c.textContent)).toEqual(['Organisations-Admin', 'Ordner-Admin', 'Bearbeiter:in', 'Leser:in', 'Prüfer:in']);
    expect(cols.filter(c => c.classList.contains('iam-rm-sep')).map(c => c.textContent)).toEqual(['Ordner-Admin']);
    unmount();
    renderIam(<RoleMatrix roles={CATALOG.roles} />, { roleGroups });
    cols = within(await screen.findByRole('table', { name: 'Rechte je Rolle' })).getAllByRole('columnheader').slice(1);
    expect(cols.map(c => c.textContent)).toEqual(['Organisations-Admin', 'Bearbeiter:in', 'Leser:in', 'Prüfer:in', 'Ordner-Admin']);
    expect(cols.filter(c => c.classList.contains('iam-rm-sep')).map(c => c.textContent)).toEqual(['Bearbeiter:in', 'Prüfer:in', 'Ordner-Admin']);
  });

  it('Gruppe aufklappbar: je Recht eine Zeile mit ja/nein je Rolle, per Tastatur', async () => {
    const u = userEvent.setup();
    const roles = CATALOG.roles.filter(r => ['editor', 'viewer'].includes(r.key));
    renderIam(<RoleMatrix roles={roles} highlight={['viewer']} highlightAs="selected" />);
    const table = await screen.findByRole('table', { name: 'Rechte je Rolle (gewählte Rollen hervorgehoben)' });
    const btn = within(table).getByRole('button', { name: 'Notizen' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(within(table).queryByRole('rowheader', { name: 'Notizen ändern' })).toBeNull();
    btn.focus();
    await u.keyboard('{Enter}');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const heads = within(table).getAllByRole('rowheader').map(h => h.textContent);
    expect(heads.slice(heads.indexOf('Notizen'), heads.indexOf('Notizen') + 5)).toEqual(['Notizen', 'Notizen lesen', 'Notizen ändern', 'Notizen löschen', 'Ordner verwalten']);
    const [editor, viewer] = within(within(table).getByRole('row', { name: /^Notizen ändern/ })).getAllByRole('cell');
    expect(editor).toHaveTextContent('ja');
    expect(editor).toHaveClass('iam-rm-all');
    expect(viewer).toHaveTextContent(/^–nein$/);
    expect(viewer).toHaveClass('iam-rm-none', 'iam-mine');
    await u.keyboard(' ');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(within(table).queryByRole('row', { name: /^Notizen ändern/ })).toBeNull();
    expect(table).not.toHaveTextContent(/note:/);
  });

  it('Hover in einer Zeile hebt die Markierung der Spalte nicht auf (Regel mit höherer Spezifität)', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8');
    const rule = /([^{}\n]*:hover[^{}\n]*)\{background:var\(--iam-accent-soft\)\}/.exec(css);
    expect(rule?.[1]?.trim()).toBe('.iam-role-matrix tbody tr:hover td.iam-mine');
    const spec = (sel: string) => (sel.match(/[.:][\w-]+/g) ?? []).length;
    expect(spec(rule![1]!)).toBeGreaterThan(spec('.iam-tbl tbody tr:hover td'));
  });
});
