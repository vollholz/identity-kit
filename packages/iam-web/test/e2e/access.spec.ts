/**
 * Seite «Zugriff» im Browser: axe hell und dunkel, 390 px ohne waagrechtes Scrollen (Liste, Dialog mit Vorschau,
 * «Rechte prüfen»), Zugriffsregel per Tastatur anlegen und über das Menü entfernen.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations
  .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const scheme of ['light', 'dark'] as const) {
  test(`Zugriff: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin.html?p=access');
      const table = page.getByRole('table', { name: 'Zugriffsregeln' });
      await expect(table).toBeVisible();
      await expect(table).toContainText('Carla Check');
      expect(await axe(page), `Zugriffsregeln ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Zugriffsregeln ${width}`).toBe(true);

      await page.getByRole('button', { name: 'Zugriffsregel hinzufügen' }).first().click();
      const dlg = page.getByRole('dialog', { name: 'Zugriffsregel in «Demo AG» hinzufügen' });
      await dlg.getByRole('button', { name: 'Hinzufügen' }).click();
      await expect(dlg.getByText('Bitte wählen.')).toBeVisible();
      expect(await axe(page), `Dialog leer ${width}`).toEqual([]);
      await dlg.getByRole('button', { name: 'Ordner' }).click();
      const picker = page.getByRole('dialog', { name: 'Ordner wählen' });
      await picker.getByRole('option', { name: /Archiv/ }).click();
      await expect(dlg.getByRole('status', { name: 'Vorschau' })).toContainText('Auf Ordner «Archiv mit einem langen Ordnernamen»');
      expect(await axe(page), `Dialog Vorschau ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Dialog ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('tab', { name: 'Rechte prüfen' }).click();
      const form = page.getByRole('form', { name: 'Rechte prüfen' });
      await form.getByRole('button', { name: 'Rolle(n)' }).click();
      await form.getByRole('group', { name: 'Rollen' }).getByRole('button', { name: 'Leser:in' }).click();
      await expect(page.getByRole('list', { name: 'Entscheid je Ressource' })).toContainText('verboten');
      expect(await axe(page), `Rechte prüfen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Rechte prüfen ${width}`).toBe(true);
    }
  });
}

test('Zugriffsregel per Tastatur anlegen (Ordner über die Auswahl) und über das Menü entfernen', async ({ page }) => {
  await page.goto('/admin.html?p=access');
  await expect(page.getByRole('table', { name: 'Zugriffsregeln' })).toBeVisible();
  await page.getByRole('button', { name: 'Zugriffsregel hinzufügen' }).first().focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Zugriffsregel in «Demo AG» hinzufügen' });
  await expect(dlg.getByRole('combobox', { name: 'Ressource' })).toBeFocused();
  // Ordner: Auswahl öffnen, suchen, mit Enter wählen
  await page.keyboard.press('Tab');
  await expect(dlg.getByRole('button', { name: 'Ordner' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Ordner wählen' })).toBeVisible();
  await page.keyboard.type('Proj');
  await expect(page.getByRole('dialog', { name: 'Ordner wählen' }).getByRole('option', { name: /Projekte/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Ordner wählen' })).toHaveCount(0);
  await expect(dlg.getByRole('button', { name: 'Ordner' })).toContainText('Projekte');
  await dlg.getByRole('combobox', { name: 'Rolle' }).focus();
  await page.keyboard.press('End');
  await expect(dlg.getByRole('combobox', { name: 'Rolle' })).toHaveValue('auditor');
  await dlg.getByRole('button', { name: 'Verbieten' }).focus();
  await page.keyboard.press('Enter');
  await expect(dlg.getByRole('button', { name: 'Verbieten' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dlg.getByRole('status', { name: 'Vorschau' })).toContainText('Auf Ordner «Projekte» verlieren Personen mit Rolle «Prüfer:in»');
  await dlg.getByRole('button', { name: 'Hinzufügen' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Zugriffsregel in «Demo AG» hinzugefügt')).toBeVisible();
  const more = page.getByRole('button', { name: /^Mehr zu «Notizen lesen» verboten für Rolle «Prüfer:in» auf Projekte$/ });
  await expect(more).toBeVisible();

  const first = page.getByRole('button', { name: 'Mehr zu «Notizen ändern» beschränkt für Rolle «Bearbeiter:in» auf Projekte' });
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Zugriffsregel entfernen …' })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Zugriffsregel in «Demo AG» entfernen?' });
  await expect(confirm.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Entfernen' }).click();
  await expect(page.getByText('Zugriffsregel in «Demo AG» entfernt')).toBeVisible();
  await expect(first).toHaveCount(0);
});
