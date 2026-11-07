/**
 * Seite «Module» im Browser: axe hell und dunkel, 390 px ohne waagrechtes Scrollen (Liste, Rückfragen, Schublade),
 * Schalter aller Zeilen in einer Spalte (auch Teilfunktion und Pflichtmodul),
 * Schalten per Tastatur (Voraussetzung mitaktivieren, Deaktivieren mit Wirkung, Hindernisse), Navigation «Zugang»;
 * Abschnitt der Plattform-Administration mit «Trotzdem entziehen».
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations
  .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const scheme of ['light', 'dark'] as const) {
  test(`Module: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/modules.html');
      await expect(page.getByRole('switch', { name: 'Zeiterfassung aktiv' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Zugang' }).getByRole('link', { name: 'Module' })).toHaveAttribute('aria-current', 'page');
      expect(await axe(page), `Liste ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Liste ${width}`).toBe(true);

      await page.getByRole('switch', { name: 'Lohn aktiv' }).click();
      await expect(page.getByRole('alertdialog', { name: '«Lohn» aktivieren' })).toContainText('Aktiviert auch «Abwesenheiten»');
      expect(await axe(page), `Aktivieren ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Aktivieren ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('switch', { name: 'Zeiterfassung aktiv' }).click();
      const off = page.getByRole('alertdialog', { name: '«Zeiterfassung» deaktivieren' });
      await expect(off).toContainText('3 offene Korrekturanträge – zuerst entscheiden');
      expect(await axe(page), `Deaktivieren ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Deaktivieren ${width}`).toBe(true);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Zeiterfassung', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Zeiterfassung' })).toContainText('Zeit erfassen');
      expect(await axe(page), `Schublade ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Schublade ${width}`).toBe(true);
      await page.keyboard.press('Escape');
    }
  });

  test(`Module der Plattform-Administration: axe, 390 px (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/modules.html?p=platform');
      await expect(page.getByRole('table', { name: 'Module von Muster GmbH' })).toBeVisible();
      expect(await axe(page), `Liste ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Liste ${width}`).toBe(true);
      await page.getByRole('button', { name: 'Zeiterfassung entziehen' }).click();
      await expect(page.getByRole('alertdialog')).toContainText('3 offene Korrekturanträge');
      expect(await axe(page), `Entziehen ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Entziehen ${width}`).toBe(true);
      await page.keyboard.press('Escape');
    }
  });
}

test('Schalter aller Zeilen (Modul, Teilfunktion, Pflichtmodul) in derselben Spalte; nur der Text der Teilfunktion eingerückt', async ({ page }) => {
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/modules.html');
    await expect(page.getByRole('switch', { name: 'Kern aktiv' })).toHaveAttribute('aria-disabled', 'true');
    const rows = await page.locator('.iam-mod-row').evaluateAll(els => els.map(r => ({
      part: r.classList.contains('iam-mod-part'),
      sw: Math.round(r.querySelector('.iam-switch')!.getBoundingClientRect().right),
      text: Math.round(r.querySelector('.iam-mod-name')!.getBoundingClientRect().left),
    })));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map(r => r.sw)).size, `Schalter ${width}`).toBe(1);
    const mod = rows.find(r => !r.part)!.text, part = rows.find(r => r.part)!.text;
    expect(part - mod, `Einzug ${width}`).toBeGreaterThan(10);
  }
});

test('per Tastatur: Lohn mit Voraussetzung aktivieren, Abwesenheiten bleibt gebraucht, Lohn deaktivieren', async ({ page }) => {
  await page.goto('/modules.html');
  const lohn = page.getByRole('switch', { name: 'Lohn aktiv' });
  await lohn.focus();
  await page.keyboard.press('Space');
  const dlg = page.getByRole('alertdialog', { name: '«Lohn» aktivieren' });
  await expect(dlg.getByRole('button', { name: 'Alle 2 aktivieren' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dlg).toBeHidden();
  await expect(lohn).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('switch', { name: 'Abwesenheiten aktiv' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('«Lohn» ist aktiv, mit «Abwesenheiten».')).toBeVisible();

  // Abwesenheiten wird von Lohn gebraucht: Rückfrage ohne «Deaktivieren»
  await page.getByRole('switch', { name: 'Abwesenheiten aktiv' }).focus();
  await page.keyboard.press('Enter');
  const need = page.getByRole('alertdialog', { name: '«Abwesenheiten» deaktivieren' });
  await expect(need).toContainText('Noch gebraucht von «Lohn»');
  await expect(need.getByRole('button', { name: 'Deaktivieren' })).toHaveCount(0);
  await expect(need.getByRole('button', { name: 'Schliessen' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('switch', { name: 'Abwesenheiten aktiv' })).toBeFocused();

  await lohn.focus();
  await page.keyboard.press('Space');
  const off = page.getByRole('alertdialog', { name: '«Lohn» deaktivieren' });
  await expect(off.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(off.getByRole('button', { name: 'Deaktivieren' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(off).toBeHidden();
  await expect(lohn).toHaveAttribute('aria-checked', 'false');
});

test('Plattform: Zeiterfassung trotz Hindernissen entziehen, Projekte freigeben', async ({ page }) => {
  await page.goto('/modules.html?p=platform');
  const table = page.getByRole('table', { name: 'Module von Muster GmbH' });
  await table.getByRole('button', { name: /^Projekte .* freigeben$/ }).click();
  await expect(page.getByText(/ist für «Muster GmbH» freigegeben/)).toBeVisible();
  await table.getByRole('button', { name: 'Zeiterfassung entziehen' }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.getByRole('button', { name: 'Trotzdem entziehen' }).click();
  await expect(dlg).toBeHidden();
  await expect(table.getByRole('row', { name: /Zeiterfassung/ })).toContainText('Nicht freigegeben');
});
