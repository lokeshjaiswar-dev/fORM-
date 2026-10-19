import { defineConfig, devices } from '@playwright/test';
import { STACK_PORTS } from './e2e/stack-ports.ts';

/**
 * WP-1.01 sign-in end to end: the production build (vite preview) in front of the real API, with Postgres and Mailpit
 * in Testcontainers and a mock OpenID provider (apps/api/test/e2e-stack.ts). `/v1` is proxied to the API, so the
 * browser sees one origin and the session cookie, Fetch-Metadata and the CSRF guard behave as behind the ingress.
 * Needs Docker. The suites share one database, so they run one at a time. Ports: e2e/stack-ports.ts.
 */
const { builder: port, api: apiPort } = STACK_PORTS;

export default defineConfig({
  testDir: './e2e',
  testMatch: /\.stack\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  /* The API stack starts here rather than as a webServer, so it can stop its containers itself (e2e/stack-setup.ts). */
  globalSetup: './e2e/stack-setup.ts',
  webServer: {
    command: `pnpm exec vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}/forms`,
    reuseExistingServer: false,
    env: { FR_DEV_API_URL: `http://127.0.0.1:${apiPort}` },
  },
});
