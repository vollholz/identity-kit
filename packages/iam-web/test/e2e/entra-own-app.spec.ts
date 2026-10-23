/**
 * Eigene App-Registrierung (0.3.0) im Browser, Server ohne App der Plattform (`?own=1`): axe hell und dunkel, 390 px
 * ohne waagrechtes Scrollen (Abschnitt, Dialog mit Anleitung, verbunden mit Warnung zum Secret, Secret wechseln,
 * öffentliche Seite «Credentials eintragen») und der ganze Ablauf über den Link mit Fehler und Erfolg.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations
  .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const TOKEN = 'demo.e2eCredentialsToken_0123456789abcdefABCDEFG';
const TID = '3f2b6c1e-8a4d-4f0e-9c7b-1d2e3f4a5b6c';
const CID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

for (const scheme of ['light', 'dark'] as const) {
  test(`Eigene App: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    // Ohne Animation: axe misst den Toast sonst mitten im Einblenden
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin.html?p=entra&own=1');
      await expect(page.getByRole('button', { name: 'Eigene App verbinden' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Mit Entra ID verbinden' })).toHaveCount(0);
      expect(await axe(page), `Abschnitt ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Abschnitt ${width}`).toBe(true);

      await page.getByRole('button', { name: 'Eigene App verbinden' }).click();
      const dlg = page.getByRole('dialog', { name: '«Demo AG» mit eigener App-Registrierung verbinden' });
      await expect(dlg.getByLabel('Umleitungs-URI')).toHaveValue(/broker\/entra-demo\/endpoint$/);
      expect(await axe(page), `Dialog ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Dialog ${width}`).toBe(true);
      await dlg.getByLabel('Verzeichnis', { exact: true }).fill(TID);
      await dlg.getByLabel('Anwendungs-ID').fill(CID);
      await dlg.getByLabel('Geheimer Clientschlüssel (Wert)').fill('wert');
      await dlg.getByRole('button', { name: 'Verbinden' }).click();
      await expect(page.getByText('Das Secret läuft bald ab.', { exact: false })).toBeVisible();
      expect(await axe(page), `Verbunden ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Verbunden ${width}`).toBe(true);

      await page.getByRole('button', { name: 'Secret wechseln …' }).click();
      const rot = page.getByRole('dialog', { name: 'Secret für «Demo AG» wechseln' });
      await expect(rot.getByLabel('Geheimer Clientschlüssel (Wert)')).toBeFocused();
      expect(await axe(page), `Secret wechseln ${width}`).toEqual([]);

      await page.goto(`/admin.html?p=handover#${TOKEN}`);
      await expect(page.getByRole('heading', { name: 'App-Registrierung für die Anmeldung über Microsoft eintragen' })).toBeVisible();
      expect(await axe(page), `Öffentlich ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Öffentlich ${width}`).toBe(true);
    }
  });
}

test('ganzer Ablauf: Link «Credentials eintragen», Seite ohne Sitzung, Fehler mit eigenem Text, gespeichert', async ({ page, context }) => {
  await page.goto('/admin.html?p=entra&own=1');
  await page.getByRole('button', { name: 'Link an die Entra-Administration senden' }).click();
  const dlg = page.getByRole('dialog', { name: 'Link an die Entra-Administration von «Demo AG»' });
  await expect(dlg).toContainText('Das Secret siehst du so nie.');
  await dlg.getByRole('textbox', { name: 'Verzeichnis' }).fill(TID);
  await dlg.getByRole('button', { name: 'Link erzeugen' }).click();
  const url = await page.getByRole('dialog', { name: 'Link für «Demo AG» erzeugt' }).getByLabel('Link').inputValue();
  expect(url).toContain(`#${TOKEN}`);

  const it = await context.newPage();
  const network: string[] = [];
  it.on('request', r => network.push(r.url()));
  await it.goto(url);
  await expect(it.getByRole('heading', { name: 'App-Registrierung für die Anmeldung über Microsoft eintragen' })).toBeVisible();
  expect(await it.evaluate(() => location.hash)).toBe('');
  await expect(it.getByLabel('Verzeichnis', { exact: true })).toHaveCount(0);
  await expect(it.getByText('0f1e2d3c-4b5a-4697-8876-a5b4c3d2e1f0')).toBeVisible();
  await it.getByLabel('Anwendungs-ID').fill(CID);
  await it.getByLabel('Geheimer Clientschlüssel (Wert)').fill('falsch');
  await it.getByRole('button', { name: 'Angaben prüfen und speichern' }).click();
  await expect(it.getByRole('alert')).toContainText('Microsoft lehnt das Secret ab.');
  await it.getByLabel('Geheimer Clientschlüssel (Wert)').fill('richtig');
  await it.getByRole('button', { name: 'Angaben prüfen und speichern' }).click();
  await expect(it.getByRole('heading', { name: 'Gespeichert' })).toBeVisible();

  // Token und Secret nur im Body der öffentlichen Aufrufe, nie in einer Adresse
  const requests = await it.evaluate(() => JSON.parse(sessionStorage.getItem('iamCalls') ?? '[]') as { url: string; body: string }[]);
  expect(requests.map(r => new URL(r.url).pathname)).toEqual(['/v1/entra/handover/info', '/v1/entra/handover/credentials', '/v1/entra/handover/credentials']);
  for (const u of [...network, ...requests.map(r => r.url)]) {
    expect([TOKEN, encodeURIComponent(TOKEN), 'richtig'].some(x => u.includes(x)), u).toBe(false);
    expect(new URL(u).search, u).not.toMatch(/%23/);
  }
  expect(requests.filter(r => r.body.includes('richtig')).map(r => new URL(r.url).pathname)).toEqual(['/v1/entra/handover/credentials']);
});
