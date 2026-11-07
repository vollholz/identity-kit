/**
 * Seite «Module» im Browser: axe hell und dunkel, 390 px ohne waagrechtes Scrollen (Liste, Rückfragen, Schublade),
 * Raster (Status und Schalter bündig, Telefon 360 px: Status unter dem Namen), Touch-Ziele ≥ 44 px,
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

test('Raster: Status und Schalter aller Zeilen (auch Teilfunktion und Pflichtmodul) bündig; Telefon: Status unter dem Namen', async ({ page }) => {
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/modules.html');
    await expect(page.getByRole('switch', { name: 'Kern aktiv' })).toHaveAttribute('aria-disabled', 'true');
    const boxes = await page.locator('.iam-mod-row').evaluateAll(rows => rows.map(r => {
      const b = (sel: string) => r.querySelector(sel)!.getBoundingClientRect();
      const name = b('.iam-mod-name'), status = b('.iam-mod-status .iam-pill'), sw = b('.iam-mod-switch');
      return { part: r.classList.contains('iam-mod-part'), nameTop: name.top, nameBottom: name.bottom, statusLeft: status.left, statusTop: status.top, swLeft: sw.left, swRight: sw.right, swTop: sw.top };
    }));
    expect(boxes).toHaveLength(6);
    // Schalter in allen Zeilen in derselben Spalte, oben auf der ersten Textzeile
    expect(new Set(boxes.map(b => Math.round(b.swRight))).size, `Schalter ${width}`).toBe(1);
    for (const b of boxes) expect(Math.abs(b.swTop - b.nameTop), `Schalter oben ${width}`).toBeLessThanOrEqual(2);
    if (width > 520) {
      // Status in derselben Spalte, auf der Linie des Namens
      expect(new Set(boxes.map(b => Math.round(b.statusLeft))).size, 'Status').toBe(1);
      for (const b of boxes) expect(b.statusTop).toBeLessThan(b.nameTop + 6);
    } else {
      // Telefon: Status unter dem Namen
      for (const b of boxes) expect(b.statusTop, 'Status unter dem Namen').toBeGreaterThanOrEqual(b.nameBottom - 1);
    }
  }
});

test('Touch: Schalter mit Zielfläche ≥ 44 px', async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('/modules.html');
  const sw = page.getByRole('switch', { name: 'Abwesenheiten aktiv' });
  await expect(sw).toBeVisible();
  const hit = await sw.evaluate(el => { const a = getComputedStyle(el, '::after'); return { w: el.getBoundingClientRect().width + 2 * -parseFloat(a.left), h: el.getBoundingClientRect().height + 2 * -parseFloat(a.top) }; });
  expect(hit.w).toBeGreaterThanOrEqual(44);
  expect(hit.h).toBeGreaterThanOrEqual(44);
  await ctx.close();
});

test('Touch, breit: Zielflächen benachbarter Schalter überlappen nicht, auch bei Zeilen ohne Text', async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/modules.html');
  await expect(page.getByRole('switch', { name: 'Kern aktiv' })).toBeVisible();
  // ungünstigster Fall: Zeilen ohne Beschreibung, Voraussetzungen und Sperrgrund (nur Name, Status, Schalter)
  await page.locator('.iam-mod-info').evaluateAll(els => els.forEach(e => e.remove()));
  const hits = await page.locator('.iam-mod-row').evaluateAll(rows => rows.map(r => {
    const sw = r.querySelector('.iam-mod-switch')!, b = sw.getBoundingClientRect(), a = getComputedStyle(sw, '::after');
    return { row: r.getBoundingClientRect().height, top: b.top + parseFloat(a.top), bottom: b.bottom - parseFloat(a.bottom) };
  }));
  expect(hits).toHaveLength(6);
  for (const h of hits) expect(h.row, 'Zeile ≥ 44 px').toBeGreaterThanOrEqual(44);
  const sorted = [...hits].sort((x, y) => x.top - y.top);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.top, `Zielfläche ${i} überlappt die vorherige`).toBeGreaterThanOrEqual(sorted[i - 1]!.bottom);
  await ctx.close();
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
