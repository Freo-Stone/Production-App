import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end against the production build.
 *
 * The app is served from `dist` exactly as GitHub Pages will serve it, because
 * the things most likely to break in production — hash routes under a base path,
 * the service worker, mobile viewport height — are precisely the ones a dev
 * server hides.
 *
 * Only chromium and firefox are installed in this environment, so the phone
 * checks use chromium device emulation rather than webkit.
 */
const PORT = 4173;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Importing a real export parses 2,691 rows on the main thread, so these tests
  // are CPU-heavy rather than I/O-heavy. Four workers on one box starve each
  // other's render loop and Playwright then times out on elements that are
  // perfectly there — two workers keeps the timing honest.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
