/**
 * Grundkomponenten im Browser: axe (WCAG 2.2 AA, ohne serious/critical) hell und dunkel, breit und 390 px, kein
 * waagrechtes Scrollen, gestapelte Tabelle, Tastatur, und Vorrang der App-Variablen vor den Vorgaben (@layer iam).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const scheme of ['light', 'dark'] as const) {
  for (const [label, viewport] of [['breit', { width: 1280, height: 900 }], ['390 px', { width: 390, height: 844 }]] as const) {
    test(`axe ohne serious/critical: ${scheme}, ${label}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(viewport);
      for (const dlg of ['', 'form', 'confirm', 'sheet']) {
        await page.goto(dlg ? `/?dlg=${dlg}` : '/');
        await expect(page.getByRole('heading', { name: 'Bausteine' })).toBeVisible();
        expect(await axe(page), `Ansicht ${dlg || 'Seite'}`).toEqual([]);
        expect(await noHorizontalScroll(page), `waagrecht gescrollt: ${dlg || 'Seite'}`).toBe(true);
      }
    });
  }
}

test('Tabelle stapelt unter 760 px und blendet «Zuletzt aktiv» aus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const row = page.getByRole('row').filter({ hasText: 'Anna Admin' });
  await expect(row).toHaveCSS('flex-direction', 'column');
  await expect(row.getByText('vor 5 Minuten')).toBeHidden();
  await expect(row.getByText('Status:')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(row.getByText('vor 5 Minuten')).toBeVisible();
  await expect(row.getByText('Status:')).toBeHidden();
});

test('Menü und Dialog per Tastatur', async ({ page }) => {
  await page.goto('/');
  const more = page.getByRole('button', { name: 'Mehr zu Anna Admin' });
  await more.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Einladung erneut senden' })).toBeFocused();
  await page.keyboard.press('End');
  const remove = page.getByRole('menuitem', { name: 'Person entfernen …' });
  await expect(remove).toBeFocused();
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(more).toBeFocused();

  const open = page.getByRole('button', { name: 'Rückfrage öffnen' });
  await open.click();
  const dlg = page.getByRole('alertdialog', { name: 'Rolle löschen?' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dlg.getByRole('button', { name: 'Rolle löschen' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(open).toBeFocused();
});

test('Auswahl per Tastatur übernimmt mehrere Rollen', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Rollen wählen (0)' }).click();
  const box = page.getByRole('combobox');
  await expect(box).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByRole('button', { name: 'Rollen wählen (2)' })).toBeFocused();
});

test('Variablen der App gehen den Vorgaben vor, auch im dunklen Thema des Systems', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/?app=1');
    const primary = page.getByRole('button', { name: 'Person einladen' });
    await expect(primary).toHaveCSS('background-color', 'rgb(1, 2, 3)');
    await expect(page.getByRole('button', { name: 'Standard' })).toHaveCSS('background-color', 'rgb(250, 240, 230)');
  }
  // ohne App: Vorgaben des Pakets, dunkel anders als hell
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const light = await page.getByRole('button', { name: 'Standard' }).evaluate(e => getComputedStyle(e).backgroundColor);
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await page.getByRole('button', { name: 'Standard' }).evaluate(e => getComputedStyle(e).backgroundColor);
  expect(light).not.toBe(dark);
});

test('Element-Regeln der App (a, h1, button ohne Klasse) überdecken die Klassen der Bausteine nicht', async ({ page }) => {
  await page.goto('/?dlg=confirm');
  // wie ein globales Reset einer App (z. B. Assets: a { color: inherit }, button { color: inherit }, h3 { margin: 0 })
  await page.addStyleTag({ content: 'a { color: inherit } button { color: inherit; background: none } h3 { margin: 40px }' });
  await expect(page.getByRole('link', { name: 'Als Link' })).toHaveCSS('background-color', await page.getByRole('button', { name: 'Standard' }).evaluate(e => getComputedStyle(e).backgroundColor));
  const del = page.getByRole('alertdialog').getByRole('button', { name: 'Rolle löschen' });
  await expect(del).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(page.getByRole('heading', { name: 'Rolle löschen?' })).toHaveCSS('margin-top', '0px');
});

test('eine Regel der App ausserhalb einer Ebene überschreibt die Klassen des Pakets', async ({ page }) => {
  await page.goto('/');
  await page.addStyleTag({ content: '.iam-btn { border-radius: 0 }' });
  await expect(page.getByRole('button', { name: 'Standard' })).toHaveCSS('border-radius', '0px');
});
