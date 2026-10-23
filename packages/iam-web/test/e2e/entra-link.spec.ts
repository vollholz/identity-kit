/**
 * Link an die Entra-Administration im Browser: axe hell und dunkel, 390 px ohne waagrechtes Scrollen (Dialog, Liste,
 * öffentliche Freigabe, Rückkehr) und der ganze Ablauf – Link erzeugen, in einer zweiten Seite ohne Sitzung öffnen
 * (Fragment danach weg), bei Microsoft zustimmen (nachgebildet) und «Verbunden».
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations
  .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const TOKEN = 'demo.e2eHandoverToken_0123456789abcdefABCDEFGHIJ';

/** Microsoft nachgebildet: die Zustimmung leitet sofort auf die Rückkehrseite der Testseite. */
const fakeMicrosoft = (page: Page) => page.route('https://login.microsoftonline.com/**', r => r.fulfill({
  status: 302, headers: { location: `${new URL(page.url()).origin}/admin.html?p=handoverReturn&code=e2e-code&state=h.demo.e2e` },
}));

for (const scheme of ['light', 'dark'] as const) {
  test(`Link an die Entra-Administration: axe ohne serious/critical, 390 px ohne waagrechtes Scrollen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin.html?p=entra');
      await expect(page.getByRole('table', { name: /Links an die Entra-Administration/ })).toContainText('gescheitert');
      expect(await axe(page), `Liste ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Liste ${width}`).toBe(true);
      await page.getByRole('button', { name: 'Link an die Entra-Administration senden' }).click();
      const dlg = page.getByRole('dialog', { name: 'Link an die Entra-Administration von «Demo AG»' });
      expect(await axe(page), `Dialog ${width}`).toEqual([]);
      await dlg.getByRole('button', { name: 'Link erzeugen' }).click();
      const done = page.getByRole('dialog', { name: 'Link für «Demo AG» erzeugt' });
      await expect(done.getByLabel('Link')).toHaveValue(new RegExp(`#${TOKEN}$`));
      expect(await axe(page), `Link ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Link ${width}`).toBe(true);

      await page.goto(`/admin.html?p=handover#${TOKEN}`);
      await expect(page.getByRole('heading', { name: 'Anmeldung über Microsoft freigeben' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Bei Microsoft zustimmen' })).toBeVisible();
      expect(await axe(page), `Freigabe ${width}`).toEqual([]);
      expect(await noHorizontalScroll(page), `Freigabe ${width}`).toBe(true);

      await page.goto('/admin.html?p=handoverReturn&code=c&state=h.demo.e2e');
      await expect(page.getByRole('heading', { name: 'Verbunden' })).toBeVisible();
      expect(await axe(page), `Rückkehr ${width}`).toEqual([]);
    }
  });
}

test('ganzer Ablauf: Link erzeugen, in einer Seite ohne Sitzung öffnen, bei Microsoft zustimmen, verbunden', async ({ page, context }) => {
  await page.goto('/admin.html?p=entra');
  await page.getByRole('button', { name: 'Link an die Entra-Administration senden' }).focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Link an die Entra-Administration von «Demo AG»' });
  await expect(dlg.getByRole('textbox', { name: 'Verzeichnis' })).toBeFocused();
  await dlg.getByRole('combobox', { name: 'Gültig' }).selectOption('60');
  await dlg.getByRole('button', { name: 'Link erzeugen' }).focus();
  await page.keyboard.press('Enter');
  const done = page.getByRole('dialog', { name: 'Link für «Demo AG» erzeugt' });
  const url = await done.getByLabel('Link').inputValue();
  expect(url).toContain(`#${TOKEN}`);
  await done.getByRole('button', { name: 'Schliessen' }).click();
  await expect(page.getByRole('table', { name: /Links an die Entra-Administration/ })).toContainText('offen');

  // Zweite Seite wie bei der Entra-Administration: keine Sitzung nötig, /auth/me wird nicht gefragt
  const it = await context.newPage();
  const network: string[] = [];
  it.on('request', r => network.push(r.url()));
  await fakeMicrosoft(it);
  await it.goto(url);
  await expect(it.getByText('Anna Admin bittet Sie, die Anmeldung von «Demo AG» in Notizen mit Ihrem Microsoft-Verzeichnis zu verbinden.')).toBeVisible();
  // Token nur im Speicher der Seite: weg aus der Adresse
  expect(await it.evaluate(() => location.hash)).toBe('');
  expect(new URL(it.url()).pathname).toBe('/verwalten/anmeldung/freigabe');
  await it.getByRole('button', { name: 'Bei Microsoft zustimmen' }).click();
  await expect(it.getByRole('heading', { name: 'Verbunden' })).toBeVisible();
  await expect(it.getByText('Sie können dieses Fenster schliessen.', { exact: false })).toBeVisible();
  expect(new URL(it.url()).search).toBe('');
  // Das Token geht nur im Body von info und start an die API: in keiner Adresse (auch nicht encodiert, z. B. in
  // returnTo), in keinem anderen Body. API-Aufrufe der Testseite laufen über die Nachbildung (iamCalls), Seiten und
  // Skripte über das Netz.
  const secret = [TOKEN, encodeURIComponent(TOKEN), TOKEN.split('.')[1]!];
  const requests = await it.evaluate(() => JSON.parse(sessionStorage.getItem('iamCalls') ?? '[]') as { url: string; body: string }[]);
  expect(requests.map(r => new URL(r.url).pathname)).toEqual(['/v1/entra/handover/info', '/v1/entra/handover/start', '/v1/entra/handover/complete']);
  for (const url of [...network, ...requests.map(r => r.url)]) {
    expect(secret.some(x => url.includes(x)), url).toBe(false);
    expect(new URL(url).search, url).not.toMatch(/%23/);
  }
  expect(requests.filter(r => !/\/v1\/entra\/handover\/(info|start)$/.test(new URL(r.url).pathname) && secret.some(x => r.body.includes(x)))).toEqual([]);
  expect(requests.filter(r => r.body.includes(TOKEN)).map(r => new URL(r.url).pathname)).toEqual(['/v1/entra/handover/info', '/v1/entra/handover/start']);
});
