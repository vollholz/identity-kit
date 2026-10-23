/**
 * Verwalten-Seiten Mitglieder und Rollen im Browser: axe hell und dunkel, 390 px ohne waagrechtes Scrollen (Liste
 * gestapelt, Dialoge), Einladen und Rollen setzen per Tastatur, eigene Rolle anlegen, Navigation «Zugang».
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations
  .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const scheme of ['light', 'dark'] as const) {
  test(`Mitglieder und Rollen: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin.html');
      const table = page.getByRole('table', { name: 'Mitglieder von Demo AG mit Rollen' });
      await expect(table).toBeVisible();
      await page.getByText('Rollen und Rechte').click();
      expect(await axe(page), `Liste ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Liste ${width}`).toBe(true);
      // gestapelt unter 760 px: «Zuletzt aktiv» fällt weg, Sortierung als Auswahl
      await expect(page.getByRole('combobox', { name: /^Sortierung:/ })).toBeVisible({ visible: width < 760 });

      await page.getByRole('button', { name: 'Person einladen' }).click();
      const invite = page.getByRole('dialog', { name: 'Person zu «Demo AG» einladen' });
      await invite.getByRole('button', { name: 'Einladen' }).click();
      await expect(invite.getByRole('textbox', { name: 'E-Mail' })).toHaveAttribute('aria-invalid', 'true');
      expect(await axe(page), `Einladen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Einladen ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Rollen von Carla Check bearbeiten' }).click();
      const roles = page.getByRole('dialog', { name: 'Rollen von Carla Check in «Demo AG»' });
      await roles.getByText('Prüfer:in', { exact: true }).click();
      await expect(roles.getByText(/^\+ 2 Rechte/)).toBeVisible();
      expect(await axe(page), `Rollendialog ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Rollendialog ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Rollen von Anna Admin ansehen' }).click();
      const view = page.getByRole('dialog', { name: 'Rollen von Anna Admin in «Demo AG»' });
      await view.getByText('Rollen vergleichen').click();
      expect(await axe(page), `Ansehen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Ansehen ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('navigation', { name: 'Zugang' }).getByRole('link', { name: 'Rollen' }).click();
      const builtin = page.getByRole('region', { name: 'Vordefinierte Rollen' });
      await expect(builtin).toBeVisible();
      await builtin.getByRole('button', { name: 'Rechte von Bearbeiter:in' }).click();
      expect(await axe(page), `Rollen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Rollen ${width}`).toBe(true);
      await page.getByRole('button', { name: 'Rolle erstellen' }).first().click();
      const create = page.getByRole('dialog', { name: 'Rolle in «Demo AG» erstellen' });
      await create.getByRole('button', { name: 'Rolle erstellen' }).click();
      await expect(create.getByText('Namen angeben')).toBeVisible();
      expect(await axe(page), `Rolle erstellen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Rolle erstellen ${width}`).toBe(true);
    }
  });
}

test('Person per Tastatur einladen: Fokus im Dialog, Rolle wählen, Enter sendet; Person in der Liste', async ({ page }) => {
  await page.goto('/admin.html');
  await expect(page.getByRole('table', { name: /^Mitglieder/ })).toBeVisible();
  const open = page.getByRole('button', { name: 'Person einladen' });
  await open.focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Person zu «Demo AG» einladen' });
  await expect(dlg.getByRole('textbox', { name: 'E-Mail' })).toBeFocused();
  await page.keyboard.type('paul@demo.example');
  // Tab durch Vorname und Nachname zu den Rollen; Leser:in ist vorgewählt
  await expect(dlg.getByRole('checkbox', { name: 'Leser:in' })).toBeChecked();
  const editor = dlg.getByRole('checkbox', { name: 'Bearbeiter:in' });
  await editor.focus();
  await page.keyboard.press('Space');
  await expect(editor).toBeChecked();
  await expect(dlg.getByText('Darf 3 von 10')).toBeVisible();
  await dlg.getByRole('textbox', { name: 'E-Mail' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Einladung zu «Demo AG» an paul@demo.example versendet')).toBeVisible();
  await expect(dlg).toHaveCount(0);
  const row = page.getByRole('row', { name: /paul/ });
  await expect(row).toContainText('eingeladen');
  await expect(row.getByRole('list', { name: 'Rollen von paul' })).toHaveText(/Bearbeiter:inLeser:in|Leser:inBearbeiter:in/);
});

test('Rollen per Tastatur setzen: «Speichern» mit Enter, Fokus zurück auf den Zeilenknopf', async ({ page }) => {
  await page.goto('/admin.html');
  const open = page.getByRole('button', { name: 'Rollen von Carla Check bearbeiten' });
  await open.focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Rollen von Carla Check in «Demo AG»' });
  const auditor = dlg.getByRole('checkbox', { name: 'Prüfer:in' });
  await auditor.focus();
  await page.keyboard.press('Space');
  await expect(dlg.getByRole('list', { name: /^Änderungen:/ })).toContainText('Protokoll lesen');
  await dlg.getByRole('button', { name: 'Speichern' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Rollen von Carla Check in «Demo AG» gespeichert')).toBeVisible();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Rollen von Carla Check' })).toContainText('Prüfer:in');
  await expect(open).toBeFocused();
});

test('eigene Rolle anlegen mit Vorlage; danach in der Liste und im Rollendialog der Mitglieder', async ({ page }) => {
  await page.goto('/admin.html?p=roles');
  const folder = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Ordner-Admin' }) });
  await folder.getByRole('button', { name: 'Mehr zu Ordner-Admin' }).click();
  await page.getByRole('menuitem', { name: 'Als Vorlage für eigene Rolle …' }).click();
  const dlg = page.getByRole('dialog', { name: 'Rolle in «Demo AG» erstellen' });
  await dlg.getByRole('textbox', { name: 'Name' }).fill('Ordnerpflege');
  await dlg.getByRole('checkbox', { name: 'Notizen löschen' }).uncheck();
  await dlg.getByRole('button', { name: 'Rolle erstellen' }).click();
  await expect(page.getByText('Rolle «Ordnerpflege» in «Demo AG» erstellt')).toBeVisible();
  const own = page.getByRole('region', { name: 'Eigene Rollen' });
  await expect(own.getByRole('heading', { name: 'Ordnerpflege' })).toBeVisible();
  await expect(own).toContainText('5 Rechte · 0 Personen · c-ordnerpflege');

  await page.getByRole('navigation', { name: 'Zugang' }).getByRole('link', { name: 'Mitglieder' }).click();
  await expect(page.getByRole('navigation', { name: 'Zugang' }).getByRole('link', { name: 'Mitglieder' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Rollen von Carla Check bearbeiten' }).click();
  const roles = page.getByRole('dialog', { name: 'Rollen von Carla Check in «Demo AG»' });
  await expect(roles.getByRole('group', { name: 'Eigene Rollen' })).toContainText('Ordnerpflege');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`Maschinen-Clients und Organisationen: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin.html?p=clients');
      await expect(page.getByRole('table', { name: 'Freigegebene Maschinen-Clients von Demo AG' })).toBeVisible();
      await page.getByRole('button', { name: /Rechte anzeigen\s?, notiz-import$/ }).click();
      expect(await axe(page), `Clients ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Clients ${width}`).toBe(true);
      await page.getByRole('button', { name: 'Maschinen-Client freigeben' }).first().click();
      const grant = page.getByRole('dialog', { name: 'Maschinen-Client für «Demo AG» freigeben' });
      await grant.getByRole('button', { name: 'Freigeben' }).click();
      await expect(grant.getByRole('textbox', { name: 'Client-ID' })).toHaveAttribute('aria-invalid', 'true');
      expect(await axe(page), `Freigeben ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Freigeben ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('navigation', { name: 'Zugang' }).getByRole('link', { name: 'Organisationen' }).click();
      await expect(page.getByRole('table', { name: 'Organisationen' })).toBeVisible();
      expect(await axe(page), `Organisationen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Organisationen ${width}`).toBe(true);
      await page.getByRole('button', { name: 'Organisation anlegen' }).first().click();
      const create = page.getByRole('dialog', { name: 'Organisation anlegen' });
      await create.getByRole('button', { name: 'Anlegen' }).click();
      expect(await axe(page), `Anlegen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Anlegen ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('link', { name: 'Muster GmbH' }).click();
      await expect(page.getByRole('note')).toContainText('Du bearbeitest «Muster GmbH» (angemeldet in «Demo AG»).');
      await expect(page.getByRole('table', { name: 'Mitglieder von Muster GmbH mit Rollen' })).toBeVisible();
      expect(await axe(page), `Organisation ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Organisation ${width}`).toBe(true);
      await page.getByRole('button', { name: 'Sperren' }).click();
      await expect(page.getByRole('alertdialog', { name: '«Muster GmbH» sperren?' })).toBeVisible();
      expect(await axe(page), `Sperren ${width}`).toEqual([]);
      await page.keyboard.press('Escape');
    }
  });
}

test('Maschinen-Client per Tastatur freigeben und Freigabe über das Menü entziehen', async ({ page }) => {
  await page.goto('/admin.html?p=clients');
  await expect(page.getByRole('table', { name: /^Freigegebene Maschinen-Clients/ })).toBeVisible();
  await page.getByRole('button', { name: 'Maschinen-Client freigeben' }).first().focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Maschinen-Client für «Demo AG» freigeben' });
  await expect(dlg.getByRole('textbox', { name: 'Client-ID' })).toBeFocused();
  await page.keyboard.type('notiz-2');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Zweiter Import');
  await page.keyboard.press('Enter');
  await expect(page.getByText('«notiz-2» für «Demo AG» freigegeben')).toBeVisible();
  await expect(page.getByRole('row', { name: /notiz-2/ })).toContainText('Zweiter Import');
  const more = page.getByRole('button', { name: 'Mehr zu neu-client' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Freigabe entziehen …' })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Freigabe für «neu-client» in «Demo AG» entziehen?' });
  await expect(confirm.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Entziehen' }).click();
  await expect(page.getByText('Freigabe für «neu-client» in «Demo AG» entzogen')).toBeVisible();
  await expect(page.getByRole('row', { name: /neu-client/ })).toHaveCount(0);
});

test('Organisation sperren und entsperren; die eigene Organisation bleibt gesperrt mit Grund', async ({ page }) => {
  await page.goto('/admin.html?p=organization');
  await page.getByRole('button', { name: 'Sperren' }).click();
  const dlg = page.getByRole('alertdialog', { name: '«Muster GmbH» sperren?' });
  await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await dlg.getByRole('textbox', { name: 'Grund (Protokoll)' }).fill('Test');
  await dlg.getByRole('button', { name: 'Sperren' }).click();
  await expect(page.getByText('«Muster GmbH» gesperrt')).toBeVisible();
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Entsperren' }).click();
  await expect(page.getByText('«Muster GmbH» entsperrt')).toBeVisible();
  await page.getByRole('navigation', { name: 'Pfad' }).getByRole('link', { name: 'Organisationen' }).click();
  await page.getByRole('link', { name: 'Demo AG' }).click();
  await expect(page.getByText('deine Organisation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sperren' })).toHaveAttribute('aria-disabled', 'true');
});
