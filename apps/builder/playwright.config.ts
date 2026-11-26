import { defineConfig, devices } from '@playwright/test';

/* PW_PORT: a lane's own port, so parallel runs on the shared build server never meet another worktree's preview (default 4173). */
const port = Number(process.env['PW_PORT']) || 4173;

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env['PW_CHROMIUM_PATH'] ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } } : {}) } },
    /* The sandboxed upload child is checked in a second engine (SEC-DESIGN 3.3 B3: 'self' in an opaque-origin document is engine specific). Only this spec runs here. */
    { name: 'firefox', testMatch: /dms-upload\.sandbox\.spec\.ts$/, use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    /* Self-contained: VITE_FP_DMS_API_BASE is baked in at build time (unset, every dms-master launch is refused), so the e2e build sets it.
     * VITE_FP_EMBED_PARENTS names the stand-in parent page (this origin): an unset list denies every parent (SEC-DESIGN 3.4). */
    command: `pnpm exec vite build && pnpm exec vite preview --port ${port} --strictPort`,
    env: { VITE_FP_DMS_API_BASE: `http://localhost:${port}/api`, VITE_FP_EMBED_PARENTS: `http://localhost:${port}` },
    timeout: 180_000,
    url: `http://localhost:${port}/forms`,
    /* An explicit PW_PORT always starts this tree's own server: a server already listening there is someone else's build. */
    reuseExistingServer: !process.env.CI && !process.env['PW_PORT'],
  },
});
