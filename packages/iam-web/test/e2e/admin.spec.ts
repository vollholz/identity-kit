/**
 * Verwalten-Seiten im Browser: Mitglieder (Personen und Clients, Freigabestufe, «+n Orte»), Organisationen und Anmeldung;
 * axe hell und dunkel, 390 px ohne waagrechtes Scrollen (Liste gestapelt, Dialoge), Einladen, Rollen setzen, Client
 * freigeben und Freigabestufe per Tastatur, Navigation «Zugang» ohne «Rollen», «Zugriff» und «Maschinen-Clients».
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations
  .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const scheme of ['light', 'dark'] as const) {
  test(`Mitglieder: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    // viele Dialoge × zwei Breiten mit axe: unter paralleler Last länger als der Standard
    test.slow();
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin.html');
      const table = page.getByRole('table', { name: 'Mitglieder von Demo AG mit Rollen' });
      await expect(table).toBeVisible();
      await expect(table).toContainText('notiz-import');
      await expect(page.getByRole('navigation', { name: 'Zugang' }).getByRole('link')).toHaveText(['Mitglieder', 'Anmeldung (Microsoft Entra ID)', 'Organisationen']);
      await page.getByText('Rollen und Rechte').click();
      expect(await axe(page), `Liste ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Liste ${width}`).toBe(true);
      // gestapelt unter 760 px: «Zuletzt aktiv» fällt weg, Sortierung als Auswahl
      await expect(page.getByRole('combobox', { name: /^Sortierung:/ })).toBeVisible({ visible: width < 760 });

      // mit Entra ID verbunden: «Person hinzufügen», daneben «Per E-Mail einladen»
      await page.getByRole('button', { name: 'Person hinzufügen' }).click();
      await page.getByRole('button', { name: 'Per E-Mail einladen' }).click();
      const invite = page.getByRole('dialog', { name: 'Person zu «Demo AG» einladen' });
      await invite.getByRole('button', { name: 'Einladen' }).click();
      await expect(invite.getByRole('textbox', { name: 'E-Mail' })).toHaveAttribute('aria-invalid', 'true');
      expect(await axe(page), `Einladen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Einladen ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Rollen von Carla Check bearbeiten' }).click();
      const roles = page.getByRole('dialog', { name: 'Rollen von Carla Check in «Demo AG»' });
      await roles.getByText('Prüfer:in', { exact: true }).click();
      await expect(roles.getByText(/^\+ 1 Recht/)).toBeVisible();
      expect(await axe(page), `Rollendialog ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Rollendialog ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Rollen von Anna Admin ansehen' }).click();
      const view = page.getByRole('dialog', { name: 'Rollen von Anna Admin in «Demo AG»' });
      await view.getByText('Rollen vergleichen').click();
      expect(await axe(page), `Ansehen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Ansehen ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Client freigeben' }).first().click();
      const grant = page.getByRole('dialog', { name: 'Maschinen-Client für «Demo AG» freigeben' });
      await grant.getByRole('button', { name: 'Freigeben' }).click();
      await expect(grant.getByRole('textbox', { name: 'Client-ID' })).toHaveAttribute('aria-invalid', 'true');
      expect(await axe(page), `Client freigeben ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Client freigeben ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Mehr zu Carla Check' }).click();
      await page.getByRole('menuitem', { name: 'Freigabestufe setzen …' }).click();
      const level = page.getByRole('dialog', { name: 'Freigabestufe von Carla Check in «Demo AG»' });
      await expect(level.getByRole('combobox', { name: 'Freigabestufe' })).toBeVisible();
      expect(await axe(page), `Freigabestufe ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Freigabestufe ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: /^\+2 Orte ?, Orte von Carla Check anzeigen$/ }).click();
      const places = page.getByRole('dialog', { name: 'Orte von Carla Check in «Demo AG»' });
      await expect(places.getByRole('table')).toContainText('Ordner «Projekte»');
      await expect(places.getByRole('table')).toContainText('Notiz «Protokoll»');
      expect(await axe(page), `Orte ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Orte ${width}`).toBe(true);
      await page.keyboard.press('Escape');
    }
  });
}

test('Person per Tastatur einladen (über «Per E-Mail einladen»): Fokus im Dialog, Rolle wählen, Enter sendet; Person in der Liste', async ({ page }) => {
  await page.goto('/admin.html');
  await expect(page.getByRole('table', { name: /^Mitglieder/ })).toBeVisible();
  const open = page.getByRole('button', { name: 'Person hinzufügen' });
  await open.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Per E-Mail einladen' }).focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Person zu «Demo AG» einladen' });
  await expect(dlg.getByRole('textbox', { name: 'E-Mail' })).toBeFocused();
  await page.keyboard.type('paul@demo.example');
  // Leser:in ist vorgewählt
  await expect(dlg.getByRole('checkbox', { name: 'Leser:in' })).toBeChecked();
  const editor = dlg.getByRole('checkbox', { name: 'Bearbeiter:in' });
  await editor.focus();
  await page.keyboard.press('Space');
  await expect(editor).toBeChecked();
  await expect(dlg.getByText('Darf 4 von 9')).toBeVisible();
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

test('Maschinen-Client per Tastatur freigeben (Rolle, Freigabestufe) und die Freigabe über das Menü entziehen', async ({ page }) => {
  await page.goto('/admin.html');
  await expect(page.getByRole('table', { name: /^Mitglieder/ })).toBeVisible();
  await page.getByRole('button', { name: 'Client freigeben' }).first().focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Maschinen-Client für «Demo AG» freigeben' });
  await expect(dlg.getByRole('textbox', { name: 'Client-ID' })).toBeFocused();
  await page.keyboard.type('notiz-2');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Zweiter Import');
  await page.keyboard.press('Tab');
  await expect(dlg.getByRole('combobox', { name: 'Freigabestufe' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await dlg.getByRole('checkbox', { name: 'Leser:in' }).focus();
  await page.keyboard.press('Space');
  await dlg.getByRole('textbox', { name: 'Beschreibung' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('«notiz-2» für «Demo AG» freigegeben')).toBeVisible();
  const row = page.getByRole('row', { name: /notiz-2/ });
  await expect(row).toContainText('Client');
  await expect(row).toContainText('vertraulich');
  const more = page.getByRole('button', { name: 'Mehr zu notiz-2' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Freigabestufe setzen …' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Freigabe entziehen …' })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Freigabe für «notiz-2» in «Demo AG» entziehen?' });
  await expect(confirm.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Entziehen' }).click();
  await expect(page.getByText('Freigabe für «notiz-2» in «Demo AG» entzogen')).toBeVisible();
  await expect(page.getByRole('row', { name: /notiz-2/ })).toHaveCount(0);
});

test('Freigabestufe per Tastatur: die eigene gesperrt mit Grund, über der eigenen nicht wählbar; gespeichert in der Liste', async ({ page }) => {
  await page.goto('/admin.html');
  await page.getByRole('button', { name: 'Mehr zu Anna Admin' }).click();
  const self = page.getByRole('menuitem', { name: 'Freigabestufe setzen …' });
  await expect(self).toHaveAttribute('aria-disabled', 'true');
  await expect(self).toContainText('Deine eigene Freigabestufe setzt jemand anderes.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Mehr zu Carla Check' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Freigabestufe von Carla Check in «Demo AG»' });
  const level = dlg.getByRole('combobox', { name: 'Freigabestufe' });
  await expect(level).toBeFocused();
  await expect(level.getByRole('option', { name: /^streng vertraulich/ })).toBeDisabled();
  await level.selectOption('1');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(dlg.getByRole('button', { name: 'Speichern' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Freigabestufe von Carla Check in «Demo AG»: «vertraulich»')).toBeVisible();
  await expect(page.getByRole('row', { name: /Carla Check/ })).toContainText('Freigabestufe:vertraulich');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`Organisationen: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin.html?p=organizations');
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

test('Organisation sperren und entsperren; auch die eigene Organisation (Plattform ohne Organisation)', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'Sperren' })).not.toHaveAttribute('aria-disabled');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`Anmeldung (Entra ID) und «Person hinzufügen»: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin.html?p=entra');
      await expect(page.getByText('verbunden, noch nicht aktiv')).toBeVisible();
      expect(await axe(page), `Anmeldung ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Anmeldung ${width}`).toBe(true);
      await page.getByRole('button', { name: 'Nur Entra aktivieren …' }).click();
      const dlg = page.getByRole('alertdialog', { name: '«Nur Entra» für «Demo AG» aktivieren?' });
      await expect(dlg.getByRole('list', { name: 'Verlieren die Anmeldung' })).toBeVisible();
      expect(await axe(page), `Nur Entra ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Nur Entra ${width}`).toBe(true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /Domänen wählen/ }).click();
      expect(await axe(page), `Domänen ${width}`).toEqual([]);
      await page.keyboard.press('Escape');

      await page.getByRole('navigation', { name: 'Zugang' }).getByRole('link', { name: 'Mitglieder' }).click();
      await page.getByRole('button', { name: 'Person hinzufügen' }).click();
      const add = page.getByRole('dialog', { name: 'Person zu «Demo AG» hinzufügen' });
      await add.getByRole('searchbox', { name: 'Im Verzeichnis suchen' }).fill('pa');
      await expect(add.getByRole('list', { name: 'Treffer im Verzeichnis' })).toBeVisible();
      expect(await axe(page), `Hinzufügen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Hinzufügen ${width}`).toBe(true);
      await page.keyboard.press('Escape');
    }
  });
}

test('«Nur Entra» per Tastatur: Liste bestätigen, dann aktivieren', async ({ page }) => {
  await page.goto('/admin.html?p=entra');
  const open = page.getByRole('button', { name: 'Nur Entra aktivieren …' });
  await open.focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('alertdialog', { name: '«Nur Entra» für «Demo AG» aktivieren?' });
  await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await expect(dlg.getByRole('button', { name: 'Nur Entra aktivieren' })).toBeDisabled();
  await dlg.getByLabel(/Verstanden/).focus();
  await page.keyboard.press('Space');
  await dlg.getByRole('button', { name: 'Nur Entra aktivieren' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('«Nur Entra» für «Demo AG» aktiviert')).toBeVisible();
  await expect(page.getByText('Nur Entra aktiv').first()).toBeVisible();
});

test('Person aus Entra ID hinzufügen: suchen, wählen, ohne E-Mail, Link zum Weitergeben', async ({ page }) => {
  await page.goto('/admin.html');
  await page.getByRole('button', { name: 'Person hinzufügen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Person zu «Demo AG» hinzufügen' });
  await expect(dlg.getByRole('searchbox', { name: 'Im Verzeichnis suchen' })).toBeFocused();
  await page.keyboard.type('pa');
  await dlg.getByRole('button', { name: /Paula Plan/ }).click();
  await dlg.getByLabel('Einladung per E-Mail senden').uncheck();
  await dlg.getByRole('button', { name: 'Hinzufügen' }).click();
  const done = page.getByRole('dialog', { name: 'Paula Plan hinzugefügt' });
  await expect(done.getByLabel('Anmeldelink')).toHaveValue(/\/auth\/entra\/entra-001\?org=demo$/);
  await done.getByRole('button', { name: 'Schliessen' }).click();
  await expect(page.getByRole('row', { name: /Paula Plan/ })).toContainText('eingeladen');
});
