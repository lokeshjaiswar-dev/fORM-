import { defineConfig, devices } from '@playwright/test';

/* The determinism job: the templates-core corpus in Chromium, Firefox and WebKit, each diffed byte-for-byte with Node. */

const port = 4181;
const vite = 'pnpm exec vite --config determinism/vite.config.ts';

export default defineConfig({
  testDir: './determinism',
  timeout: 180_000,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
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
