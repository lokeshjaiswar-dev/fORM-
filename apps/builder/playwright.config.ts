import { defineConfig, devices } from '@playwright/test';

const port = 4173;

/* Video and trace record only on reruns of failures: CI's retry (on-first-retry), or locally
 * `PW_VIDEO=1 pnpm exec playwright test --last-failed`. First runs record nothing. */
const rerun = !!process.env['PW_VIDEO'];

export default defineConfig({
  testDir: './e2e',
  /* The sign-in suite against a real API, Postgres and Mailpit runs from playwright.stack.config.ts. */
  testIgnore: /\.stack\.spec\.ts$/,
  fullyParallel: true,
  /* Build-server load gate (~/bin/pw-gate) sizes PW_WORKERS to the free cores; never more than 4. */
  workers: Math.min(4, Number(process.env['PW_WORKERS']) || 2),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: rerun ? 'on' : 'on-first-retry',
    video: rerun ? 'on' : 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env['PW_CHROMIUM_PATH'] ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } } : {}) } }],
  webServer: {
    /* Self-contained: VITE_FP_DMS_API_BASE is baked in at build time (unset, every dms-master launch is refused), so the e2e build sets it. */
    command: `pnpm exec vite build && pnpm exec vite preview --port ${port} --strictPort`,
    env: { VITE_FP_DMS_API_BASE: `http://localhost:${port}/api` },
    timeout: 180_000,
    url: `http://localhost:${port}/forms`,
    reuseExistingServer: !process.env.CI,
  },
});
