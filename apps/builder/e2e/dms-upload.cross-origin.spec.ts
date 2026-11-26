import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { DIALOG, REQ, form, handshake, log, openParent, send, typeValidCase, v1, waitFor } from './fixtures/bridge-v2.ts';

/*
 * /embed/dms-upload framed from ANOTHER origin, as in production when fORM- has its own host: the preview of a second build that
 * lists the parent in VITE_FP_EMBED_PARENTS (and itself in FP_PUBLIC_ORIGINS) and serves the app on a different port. The parent page
 * is the same stand-in as dms-upload.spec.ts, served at the main preview's origin and framing the child in a sandboxed iframe.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARENT_ORIGIN = `http://localhost:${Number(process.env['PW_PORT']) || 4173}`;

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
  childOrigin = `http://localhost:${port}`;
  const outDir = path.join(appRoot, 'node_modules/.tmp/embed-e2e-dist');
  const env = { ...process.env, VITE_FP_EMBED_PARENTS: PARENT_ORIGIN, FP_PUBLIC_ORIGINS: childOrigin };
  execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: appRoot, env, stdio: 'ignore' });
  server = spawn('pnpm', ['exec', 'vite', 'preview', '--outDir', outDir, '--port', String(port), '--strictPort'], { cwd: appRoot, env, stdio: 'ignore' });
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

test('the child answers headers: sandboxed and framable by the listed parent, the rest of the app is not', async ({ request }) => {
  const embed = await request.get(`${childOrigin}/embed/dms-upload`);
  const csp = embed.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/^sandbox allow-scripts allow-forms; /);
  expect(csp).toContain(`frame-ancestors 'self' ${PARENT_ORIGIN};`);
  expect(csp).toContain(`script-src 'self' ${childOrigin};`);
  expect(embed.headers()['x-frame-options']).toBeUndefined();
  for (const path of ['/forms', '/embed/dms-master']) {
    const other = await request.get(`${childOrigin}${path}`);
    expect(other.headers()['content-security-policy'], path).toContain("frame-ancestors 'none'");
    expect(other.headers()['x-frame-options'], path).toBe('DENY');
  }
});

test('a listed parent on another origin: hello, port, init, collect round trip', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => /Content Security Policy|Content-Security-Policy|Refused to|CORS/i.test(m.text()) && violations.push(m.text()));
  await openParent(page, { childOrigin });
  await handshake(page);
  await expect(form(page).getByRole('heading', { name: 'Master details' })).toBeVisible();
  await form(page).getByRole('textbox', { name: /Invoice Amount/ }).fill('125000');
  await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: REQ });
  const collected = await waitFor(page, 'collected');
  expect(collected['values']['d1000000-0000-4000-8000-000000000002']).toBe('125000');
  expect(collected['errors'].map((e: { code: string }) => e.code)).toEqual(['required']); // Currency, left empty
  expect(violations).toEqual([]);
});

test('the same parent can run the whole valid case through the sandbox on another origin', async ({ page }) => {
  await openParent(page, { childOrigin });
  await handshake(page);
  await typeValidCase(page);
  await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: REQ });
  expect((await waitFor(page, 'collected'))['values']).toEqual(v1.cases[0]!.expectedValidated.payload.values);
  expect((await log(page)).filter((m) => m.type === 'collected')).toHaveLength(1);
});
