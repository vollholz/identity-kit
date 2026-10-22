/**
 * Browser-Tests der Bausteine gegen die Testseite (test/e2e/app, Vite). Chromium: der installierte Playwright-Browser,
 * in Sessions ohne passenden Download über IAM_E2E_CHROMIUM (z. B. /opt/pw-browsers/chromium).
 */
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.IAM_E2E_PORT ?? 4179);
const executablePath = process.env.IAM_E2E_CHROMIUM || undefined;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}`, locale: 'de-CH', trace: 'retain-on-failure', launchOptions: { executablePath } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } }],
  webServer: {
    command: `npx vite --config ${import.meta.dirname}/vite.config.ts`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
