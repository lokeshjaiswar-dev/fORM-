import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/*
 * /embed/dms-upload framed from ANOTHER origin, as in production (DMS+ on its host, fORM- on its own): the preview of
 * a second build that lists the parent in VITE_FP_EMBED_PARENTS and serves the app on a different port. The parent page
 * is the same stand-in as dms-upload.spec.ts, served at the main preview's origin.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = JSON.parse(readFileSync(path.join(appRoot, 'src/embed/bridge/__fixtures__/fp-bridge-v1.fixtures.json'), 'utf8')) as {
  handshake: Array<{ payload: Record<string, unknown> }>;
  optionsExchange: Array<{ payload: Record<string, unknown> }>;
};
const PARENT_PAGE = readFileSync(path.join(appRoot, 'e2e/fixtures/dms-upload-parent.html'), 'utf8');
const PARENT_ORIGIN = 'http://localhost:4173';

test.describe.configure({ mode: 'serial' });
/* Chromium's Local Network Access check refuses a frame on one localhost port from a page that the test fulfils by route; production hosts are not "local". */
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'], ...(process.env['PW_CHROMIUM_PATH'] ? { executablePath: process.env['PW_CHROMIUM_PATH'] } : {}) } });

let server: ChildProcess | undefined;
let childOrigin = '';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  const outDir = path.join(appRoot, 'node_modules/.tmp/embed-e2e-dist');
  const env = { ...process.env, VITE_FP_EMBED_PARENTS: PARENT_ORIGIN };
  execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: appRoot, env, stdio: 'ignore' });
  server = spawn('pnpm', ['exec', 'vite', 'preview', '--outDir', outDir, '--port', String(port), '--strictPort'], { cwd: appRoot, env, stdio: 'ignore' });
  childOrigin = `http://localhost:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${childOrigin}/forms`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the second preview server did not start');
});

test.afterAll(() => void server?.kill());

type Msg = { type: string; id: string; replyTo?: string; payload: Record<string, any> };
const log = (page: Page) => page.evaluate(() => (window as unknown as { fpLog: Msg[] }).fpLog);
const send = (page: Page, message: unknown) => page.evaluate((m) => (window as unknown as { fpSend: (m: unknown) => void }).fpSend(m), message);
const waitFor = async (page: Page, type: string): Promise<Msg> => {
  await expect.poll(async () => (await log(page)).filter((m) => m.type === type).length, { message: `waiting for ${type}` }).toBeGreaterThan(0);
  return (await log(page)).find((m) => m.type === type)!;
};
async function openParent(page: Page, claimedParent = PARENT_ORIGIN) {
  await page.route('**/fp-parent.html**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PARENT_PAGE }));
  await page.goto(`/fp-parent.html?childOrigin=${encodeURIComponent(childOrigin)}&parent=${encodeURIComponent(claimedParent)}`);
}

test('the child answers headers: framable by the listed parent, the rest of the app is not', async ({ request }) => {
  const embed = await request.get(`${childOrigin}/embed/dms-upload`);
  expect(embed.headers()['content-security-policy']).toContain(`frame-ancestors 'self' ${PARENT_ORIGIN};`);
  expect(embed.headers()['x-frame-options']).toBeUndefined();
  const other = await request.get(`${childOrigin}/forms`);
  expect(other.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(other.headers()['x-frame-options']).toBe('DENY');
});

test('a listed parent on another origin: handshake and validate round trip', async ({ page }) => {
  await openParent(page);
  await waitFor(page, 'ready');
  await send(page, { protocol: 'fp-bridge/1', type: 'init', id: 'p-init-1', payload: fixtures.handshake[1]!.payload });
  expect((await waitFor(page, 'initialized')).payload).toEqual({ fieldCount: 14, unsupported: [] });
  const request = await waitFor(page, 'options.request');
  await send(page, { protocol: 'fp-bridge/1', type: 'options.result', id: 'p-opt-1', replyTo: request.id, payload: fixtures.optionsExchange[1]!.payload });
  const f = page.frameLocator('#child');
  await expect(f.getByRole('heading', { name: 'Master details' })).toBeVisible();
  await f.getByRole('textbox', { name: /Invoice Amount/ }).fill('125000');
  await send(page, { protocol: 'fp-bridge/1', type: 'validate', id: 'p-val-1', payload: {} });
  const validated = await waitFor(page, 'validated');
  expect(validated.replyTo).toBe('p-val-1');
  expect(validated.payload['values']['d1000000-0000-4000-8000-000000000002']).toBe('125000');
  expect(validated.payload['errors'].map((e: { code: string }) => e.code)).toEqual(['required']); // Currency, left empty
});

test('a parent that frames it legitimately but names another origin as itself: notice, nothing sent', async ({ page }) => {
  await openParent(page, 'https://evil.example');
  await expect(page.frameLocator('#child').getByTestId('upload-notice')).toHaveAttribute('data-problem', 'not_allowed');
  await page.waitForTimeout(500);
  expect(await log(page)).toEqual([]);
});
