/** Rechte-Bausteine im Browser: axe, 390 px ohne waagrechtes Scrollen (auch die Rollenmatrix), Kontomenü und Dialog per Tastatur. */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations
  .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const scheme of ['light', 'dark'] as const) {
  test(`Rechte-Bausteine: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/rights.html');
      await expect(page.getByRole('table', { name: /Rechte je Rolle/ })).toBeVisible();
      await page.getByRole('button', { name: 'Notizen' }).first().click(); // eine Gruppe der Matrix aufklappen
      await page.getByRole('button', { name: 'Warum? Notizen ändern' }).click();
      expect(await axe(page), `Seite ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Seite ${width}`).toBe(true);
      const matrix = page.locator('.iam-role-matrix');
      expect(await matrix.evaluate(e => e.scrollWidth <= e.clientWidth + 1), `Matrix ${width}`).toBe(true);

      await page.getByRole('button', { name: /^Konto:/ }).click();
      await expect(page.getByRole('menu', { name: 'Konto' })).toBeVisible();
      expect(await axe(page), `Menü ${width}`).toEqual([]);
      await page.getByRole('menuitem', { name: 'Meine Rollen und Rechte' }).click();
      const dlg = page.getByRole('dialog', { name: 'Meine Rollen und Rechte' });
      await expect(dlg.getByText('Darf 7 von 10')).toBeVisible();
      await dlg.getByText('Rollen vergleichen').click();
      expect(await axe(page), `Dialog ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Dialog ${width}`).toBe(true);
    }
  });
}

test('Kontomenü und «Meine Rollen und Rechte» per Tastatur', async ({ page }) => {
  await page.goto('/rights.html');
  const account = page.getByRole('button', { name: /^Konto:/ });
  await account.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Meine Rollen und Rechte' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Zu «Muster GmbH» wechseln' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Meine Rollen und Rechte' });
  await expect(dlg.getByRole('button', { name: 'Schliessen' })).toBeFocused();
  // Freigaben einzelner Bereiche: eigener Status statt «fehlt», gezählt, Hinweis ohne Bereiche
  await expect(dlg.getByText('Darf 7 von 10')).toBeVisible();
  await expect(dlg.getByText(/2 Rechte davon nur in einzelnen Bereichen\./)).toBeVisible();
  await expect(dlg.locator('.iam-rights-r', { hasText: 'Ordner verwalten' })).toContainText('in einzelnen Bereichen');
  await expect(dlg.getByText(/Rechte «in einzelnen Bereichen» gelten nur dort, wo eine Zugriffsregel sie freigibt/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(account).toBeFocused();
});

test('Seite ohne Recht: «Recht fehlt» unter dem Seitenkopf', async ({ page }) => {
  await page.goto('/rights.html');
  await expect(page.getByRole('heading', { level: 1, name: 'Mitglieder' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recht fehlt' })).toBeVisible();
  await expect(page.getByText('nie sichtbar')).toHaveCount(0);
});
