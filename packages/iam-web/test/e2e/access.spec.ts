/**
 * «Zugriff» an Orten der App im Browser (Spezifikation 11.4): Seitenleiste mit Wer, Rolle, Über, Bis; Freigeben per
 * Tastatur (Person, Gruppe aus Entra ID, Alle Mitglieder), Ablauf ändern und entfernen; geerbte nur am Ursprung (Pfeil);
 * «Für alle Mitglieder»; Vertraulichkeit; «Warum sehe ich das?» mit Break-Glass und Banner. axe hell und dunkel, 390 px
 * ohne waagrechtes Scrollen.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations
  .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const scheme of ['light', 'dark'] as const) {
  test(`Zugriff: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    // viele Dialoge × zwei Breiten mit axe: unter paralleler Last länger als der Standard
    test.slow();
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin.html?p=notes');
      const list = page.getByRole('list', { name: 'Ordner und Notizen' });
      await expect(list).toContainText('streng vertraulich');
      expect(await axe(page), `Liste ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Liste ${width}`).toBe(true);

      await page.getByRole('button', { name: 'Zugriff auf Protokoll …' }).click();
      const sheet = page.getByRole('dialog', { name: 'Zugriff auf «Protokoll»' });
      const table = sheet.getByRole('table', { name: 'Wer hat Zugriff auf «Protokoll»' });
      await expect(table).toContainText('Carla Check');
      await expect(table).toContainText('Team Planung mit einem langen Gruppennamen (Gruppe)');
      await expect(sheet.getByRole('switch', { name: 'Für alle Mitglieder' })).toBeVisible();
      await expect(sheet.getByRole('combobox', { name: 'Vertraulichkeit' })).toHaveValue('1');
      expect(await axe(page), `Seitenleiste ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Seitenleiste ${width}`).toBe(true);

      await sheet.getByRole('button', { name: 'Freigeben' }).click();
      const grant = page.getByRole('dialog', { name: 'Zugriff auf «Protokoll» freigeben' });
      await grant.getByRole('button', { name: 'Freigeben' }).click();
      await expect(grant.getByText('Bitte wählen.').first()).toBeVisible();
      await grant.getByRole('radio', { name: 'Gruppe aus Entra ID' }).check();
      await grant.getByRole('searchbox', { name: 'Gruppe aus Entra ID suchen' }).fill('Abt');
      await expect(grant.getByRole('button', { name: 'Abteilung X' })).toBeVisible();
      expect(await axe(page), `Freigeben ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Freigeben ${width}`).toBe(true);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);

      await page.getByRole('button', { name: 'Warum sehe ich das? (Lohnliste)' }).click();
      const why = page.getByRole('dialog', { name: 'Warum sehe ich «Lohnliste»?' });
      await expect(why.getByText('Die Vertraulichkeit «streng vertraulich» übersteigt deine Freigabestufe «vertraulich».')).toBeVisible();
      await expect(why.getByRole('region', { name: 'Notfallzugang (Break-Glass)' })).toBeVisible();
      expect(await axe(page), `Warum ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Warum ${width}`).toBe(true);
      await page.keyboard.press('Escape');
    }
  });
}

test('Freigeben per Tastatur: Person wählen, Rolle, Ablaufdatum; danach in der Liste, Ablauf ändern und entfernen', async ({ page }) => {
  await page.goto('/admin.html?p=notes');
  await page.getByRole('button', { name: 'Zugriff auf Projekte …' }).click();
  const sheet = page.getByRole('dialog', { name: 'Zugriff auf «Projekte»' });
  await expect(sheet.getByRole('table')).toContainText('Carla Check');
  // Hauptaktion im Kopf, Fokus startet in der Seitenleiste
  await sheet.getByRole('button', { name: 'Freigeben' }).focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Zugriff auf «Projekte» freigeben' });
  await expect(dlg.getByRole('radio', { name: 'Person' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dlg.getByRole('button', { name: 'Person suchen …' })).toBeFocused();
  await page.keyboard.press('Enter');
  const picker = page.getByRole('dialog', { name: 'Person wählen' });
  await page.keyboard.type('Nora');
  await expect(picker.getByRole('option', { name: /Nora Neu/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(dlg.getByRole('button', { name: 'Nora Neu' })).toBeFocused();
  // Rollen nur aus grantable (am Ordner: Ordner-Admin, Bearbeiter:in, Leser:in)
  const role = dlg.getByRole('combobox', { name: 'Rolle' });
  await expect(role.getByRole('option')).toHaveText(['Rolle wählen', 'Ordner-Admin', 'Bearbeiter:in', 'Leser:in']);
  await role.selectOption('viewer');
  await dlg.getByLabel('Gültig bis (optional)').fill('2030-12-31');
  await dlg.getByRole('button', { name: 'Freigeben' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Freigabe in «Demo AG» angelegt')).toBeVisible();
  await expect(dlg).toHaveCount(0);
  const row = sheet.getByRole('row', { name: /Nora Neu/ });
  await expect(row).toContainText('Leser:in');
  await expect(row).toContainText('direkt');
  await expect(row).toContainText('31.12.2030');

  await row.getByRole('button', { name: 'Mehr zu Nora Neu' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Ablauf ändern …' })).toBeFocused();
  await page.keyboard.press('Enter');
  const exp = page.getByRole('dialog', { name: 'Ablauf der Freigabe für Nora Neu' });
  await exp.getByLabel('Gültig bis (optional)').fill('');
  await exp.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Ablauf der Freigabe in «Demo AG» geändert')).toBeVisible();
  await expect(row).not.toContainText('31.12.2030');

  await row.getByRole('button', { name: 'Mehr zu Nora Neu' }).click();
  await page.getByRole('menuitem', { name: 'Freigabe entfernen …' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Freigabe in «Demo AG» entfernen?' });
  await expect(confirm.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Entfernen' }).click();
  await expect(page.getByText('Freigabe in «Demo AG» entfernt')).toBeVisible();
  await expect(sheet.getByRole('row', { name: /Nora Neu/ })).toHaveCount(0);
});

test('geerbt nur am Ursprung: kein Menü, Pfeil öffnet den Ort; «Für alle Mitglieder» schaltet die Freigabe', async ({ page }) => {
  await page.goto('/admin.html?p=notes');
  await page.getByRole('button', { name: 'Zugriff auf Protokoll …' }).click();
  const sheet = page.getByRole('dialog', { name: 'Zugriff auf «Protokoll»' });
  const inherited = sheet.getByRole('row', { name: /Carla Check.*Bearbeiter:in/ });
  await expect(inherited).toContainText('Ordner «Projekte»');
  await expect(inherited.getByRole('button', { name: /^Mehr zu/ })).toHaveCount(0);
  await expect(sheet.getByRole('row', { name: /Carla Check.*Leser:in/ }).getByRole('button', { name: 'Mehr zu Carla Check' })).toBeVisible();
  await inherited.getByRole('button', { name: 'Zu Ordner «Projekte»' }).click();
  // die App öffnet den Ort: hier die Seitenleiste des Ordners
  await expect(page.getByRole('dialog', { name: 'Zugriff auf «Projekte»' })).toBeVisible();
  await expect(page.locator('output')).toContainText('folder:');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Zugriff auf Protokoll …' }).click();
  const sw = page.getByRole('dialog', { name: 'Zugriff auf «Protokoll»' }).getByRole('switch', { name: 'Für alle Mitglieder' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.focus();
  await page.keyboard.press('Space');
  await expect(page.getByText('Für alle Mitglieder in «Demo AG» freigegeben')).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Space');
  await expect(page.getByText('Freigabe für alle Mitglieder in «Demo AG» entfernt')).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
});

test('Vertraulichkeit setzen bis zur eigenen Stufe; Badge in der Liste folgt', async ({ page }) => {
  await page.goto('/admin.html?p=notes');
  await page.getByRole('button', { name: 'Zugriff auf Protokoll …' }).click();
  const sheet = page.getByRole('dialog', { name: 'Zugriff auf «Protokoll»' });
  const sel = sheet.getByRole('combobox', { name: 'Vertraulichkeit' });
  await expect(sel.getByRole('option', { name: /^streng vertraulich/ })).toBeDisabled();
  await sel.selectOption('0');
  await expect(page.getByText('Vertraulichkeit «intern» gespeichert')).toBeVisible();
  await page.keyboard.press('Escape');
  const protokoll = page.getByRole('listitem').filter({ hasText: 'Notiz «Protokoll»' });
  await expect(protokoll.locator('.iam-cls')).toHaveCount(0);
  // Lohnliste ist streng vertraulich: Feld gesperrt mit Grund
  await page.getByRole('button', { name: 'Zugriff auf Lohnliste …' }).click();
  const locked = page.getByRole('dialog', { name: 'Zugriff auf «Lohnliste»' }).getByRole('combobox', { name: 'Vertraulichkeit' });
  await expect(locked).toBeDisabled();
  await expect(page.getByText(/übersteigt deine Freigabestufe «vertraulich»; ändern kann sie nur/)).toBeVisible();
});

test('Break-Glass aus «Warum?» starten: Banner auf der Seite, dann beenden', async ({ page }) => {
  await page.goto('/admin.html?p=notes');
  await page.getByRole('button', { name: 'Warum sehe ich das? (Lohnliste)' }).click();
  const why = page.getByRole('dialog', { name: 'Warum sehe ich «Lohnliste»?' });
  const bg = why.getByRole('region', { name: 'Notfallzugang (Break-Glass)' });
  await bg.getByRole('button', { name: 'Notfallzugang starten' }).click();
  await expect(bg.getByRole('textbox', { name: 'Begründung' })).toBeFocused();
  await page.keyboard.type('Lohnfrage der Geschäftsleitung');
  await bg.getByRole('combobox', { name: 'Dauer' }).selectOption('30');
  await bg.getByRole('button', { name: 'Notfallzugang starten' }).click();
  await expect(page.getByText(/^Notfallzugang aktiv bis (\d\d\.\d\d\.\d{4}, )?\d\d:\d\d$/)).toBeVisible();
  // «Warum?» lädt neu: jetzt erlaubt
  await expect(why.getByText('Du hast «Notizen lesen» an «Lohnliste»:')).toBeVisible();
  await page.keyboard.press('Escape');
  const banner = page.getByRole('region', { name: 'Notfallzugang' });
  await expect(banner).toContainText('Notfallzugang aktiv bis');
  expect(await axe(page)).toEqual([]);
  await banner.getByRole('button', { name: 'Beenden' }).click();
  await expect(page.getByText('Notfallzugang beendet')).toBeVisible();
  await expect(banner).toHaveCount(0);
});
