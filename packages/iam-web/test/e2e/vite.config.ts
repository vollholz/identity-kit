/** Testseite der Bausteine für Playwright (npm run e2e) und zum Ansehen (npm run e2e:dev). */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: `${import.meta.dirname}/app`,
  plugins: [react()],
  server: { port: Number(process.env.IAM_E2E_PORT ?? 4179), strictPort: true },
  logLevel: 'warn',
});
