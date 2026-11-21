import { defineConfig, devices } from '@playwright/test';

/* The determinism job: the templates-core corpus in Chromium, Firefox and WebKit, each diffed byte-for-byte with Node. */

const port = 4181;
const vite = 'pnpm exec vite --config determinism/vite.config.ts';

/* Video and trace record only on reruns of failures: CI's retry (on-first-retry), or locally
 * `PW_VIDEO=1 pnpm exec playwright test --last-failed`. First runs record nothing. */
const rerun = !!process.env['PW_VIDEO'];

export default defineConfig({
  testDir: './determinism',
  timeout: 180_000,
  /* Build-server load gate (~/bin/pw-gate) sizes PW_WORKERS to the free cores; never more than 4. */
  workers: Math.min(4, Number(process.env['PW_WORKERS']) || 2),
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: rerun ? 'on' : 'on-first-retry',
    video: rerun ? 'on' : 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `${vite} build && ${vite} preview --port ${port} --strictPort`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
});
