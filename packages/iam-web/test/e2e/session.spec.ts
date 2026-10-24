/** Sitzung im Browser: Auswahlseite, «nicht verfügbar», Abmeldeseite und «Sitzung abgelaufen» mit axe, 390 px, Tastatur. */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations
  .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

const VIEWS: [string, string][] = [
  ['choose', 'Organisation wählen'],
  ['unavailable', 'Organisation nicht verfügbar'],
  ['loggedout', 'Du bist abgemeldet'],
  ['', 'Angemeldet'],
];

for (const scheme of ['light', 'dark'] as const) {
  test(`Zustände der Sitzung: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [view, heading] of VIEWS) {
        await page.goto(`/session.html${view ? `?view=${view}` : ''}`);
        await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
        expect(await axe(page), `${view || 'angemeldet'} ${width}`).toEqual([]);
        expect(await noHorizontalScroll(page), `${view || 'angemeldet'} ${width}`).toBe(true);
      }
    }
  });
}

test('Sitzung abgelaufen: Dialog über allem, Fokus auf «Erneut anmelden», Eingaben bleiben, Esc schliesst', async ({ page }) => {
  await page.goto('/session.html');
  await page.getByLabel('Notiz').fill('nicht verlieren');
  await page.getByRole('button', { name: 'Notizen laden' }).click();
  const dlg = page.getByRole('alertdialog', { name: 'Sitzung abgelaufen' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('link', { name: 'Erneut anmelden' })).toBeFocused();
  await expect(dlg.getByRole('link', { name: 'Erneut anmelden' })).toHaveAttribute('href', '/auth/login?returnTo=%2Fsession.html');
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(page.getByLabel('Notiz')).toHaveValue('nicht verlieren');
});

test('Auswahlseite per Tastatur: Organisationen als Knöpfe in einer Gruppe', async ({ page }) => {
  await page.goto('/session.html?view=choose');
  const group = page.getByRole('group', { name: 'Organisation wählen' });
  await expect(group.getByRole('button')).toHaveText(['Demo AG', 'Muster GmbH']);
  await page.keyboard.press('Tab');
  await expect(group.getByRole('button', { name: 'Demo AG' })).toBeFocused();
});
