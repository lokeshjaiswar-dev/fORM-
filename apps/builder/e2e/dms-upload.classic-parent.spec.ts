import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/*
 * Cross-repo conformance of fp-bridge/1 (T-INT): the REAL classic step 2 host (FormPlusHost, bridgeParent,
 * bridgeProtocol, legacyRecord and flag, bundled straight from the classic checkout) frames the REAL fORM-
 * /embed/dms-upload page from this build, in a browser. The contract fixtures are the oracle on both sides:
 * the init classic builds, the validated payload fORM- answers, the record classic saves. Only classic's data
 * layer is stood in for (the options endpoint and the legacy renderer the host falls back to).
 *
 * Needs the classic checkout with its node_modules: CLASSIC_DIR, default ../classic beside this checkout.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const classicDir = path.resolve(process.env['CLASSIC_DIR'] ?? path.resolve(appRoot, '../../../classic'));
const harnessDir = path.join(appRoot, 'e2e/fixtures/classic-host');
/* One output folder per worker process: beforeAll runs once in every worker, and a shared folder is emptied by the next build while another worker reads it. */
const outDir = path.join(appRoot, `node_modules/.tmp/classic-host-dist-${process.pid}`);
const fixtures = JSON.parse(readFileSync(path.join(appRoot, 'src/embed/bridge/__fixtures__/fp-bridge-v1.fixtures.json'), 'utf8')) as {
  handshake: Array<{ payload: Record<string, unknown> }>;
  cases: Array<{
    userInput: Record<string, string>;
    expectedChange?: { payload: unknown };
    expectedValidated: { payload: { valid: boolean; errors: Array<{ fieldId: string; code: string }>; values: Record<string, string> } };
    expectedRecord?: Record<string, string>;
  }>;
};
const HOST_PAGE = '<!doctype html><meta charset="utf-8"><title>classic step 2 (harness)</title><div id="root"></div><script src="/fp-classic-host.js"></script>';
const SILENT_CHILD = '<!doctype html><meta charset="utf-8"><p>a child that never answers</p>';

type Msg = { type: string; id: string; replyTo?: string; payload: Record<string, any> };
type Harness = { fpLog: Msg[]; fpWarnings: string[]; fpExpectedInit: unknown; fpHost: { validate(): Promise<boolean>; getData(): Promise<Record<string, string>> } };

test.skip(!existsSync(path.join(classicDir, 'node_modules/react')), `classic checkout with node_modules not found at ${classicDir} (set CLASSIC_DIR)`);
/* Local-network checks on a page that the test fulfils by route; production hosts are not "local". */
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'], ...(process.env['PW_CHROMIUM_PATH'] ? { executablePath: process.env['PW_CHROMIUM_PATH'] } : {}) } });

let bundle = '';
test.beforeAll(() => {
  test.setTimeout(180_000);
  execFileSync('pnpm', ['exec', 'vite', 'build', '-c', path.join(harnessDir, 'vite.config.mjs')], {
    cwd: appRoot,
    env: { ...process.env, CLASSIC_DIR: classicDir, HARNESS_OUT: outDir },
    stdio: 'inherit',
  });
  bundle = readFileSync(path.join(outDir, 'classic-host.js'), 'utf8');
  rmSync(outDir, { recursive: true, force: true });
});

/** Mounts classic's step 2 on a page at this build's origin, with the child at `childUrl` (its own origin, so the default allowlist applies). */
async function openStep2(page: Page, childUrl: string) {
  await page.clock.setFixedTime(new Date('2026-11-24T10:00:00')); // the fixtures' "today" is 24-11-2026
  await page.addInitScript((url) => ((window as unknown as { __FP_URL: string }).__FP_URL = url), childUrl);
  await page.route('**/fp-classic-parent.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: HOST_PAGE }));
  await page.route('**/fp-classic-host.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle }));
  await page.route('**/fp-silent.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: SILENT_CHILD }));
  await page.goto('/fp-classic-parent.html');
}
const log = (page: Page) => page.evaluate(() => (window as unknown as Harness).fpLog);
const messages = async (page: Page, type: string) => (await log(page)).filter((m) => m.type === type);

test('classic host + fORM- child: ready -> init -> options -> edits -> change -> validate, payloads equal the contract', async ({ page }) => {
  const cspViolations: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && cspViolations.push(m.text()));
  await openStep2(page, '/embed/dms-upload');

  // The init classic builds from the document-form-builders response is the contract's init.
  expect(await page.evaluate(() => (window as unknown as Harness).fpExpectedInit)).toEqual(fixtures.handshake[1]!.payload);

  const host = page.getByTestId('formplus-host');
  await expect(host).toHaveAttribute('aria-busy', 'false'); // initialized arrived
  expect((await messages(page, 'ready'))[0]!.payload).toEqual({ version: '1', capabilities: ['options', 'readOnly'] });
  expect((await messages(page, 'initialized'))[0]!.payload).toEqual({ fieldCount: 14, unsupported: [] });
  // The master dropdown's options came through classic's own fetch path (getDropdownOptions with the master id).
  expect(await page.evaluate(() => (window as unknown as { __optionCalls: unknown[] }).__optionCalls)).toEqual([
    { masterId: 'm-1', fieldId: 'a1000000-0000-4000-8000-000000000006', page: 1, search: '' },
  ]);

  const f = page.frameLocator('iframe[title="Document properties form"]');
  await expect(f.getByRole('heading', { name: 'Document details' })).toBeVisible();
  await expect(f.getByRole('heading', { name: 'Master details' })).toBeVisible();
  await expect(f.getByRole('textbox', { name: /Invoice No/ })).toHaveValue('INV-0007');
  // The iframe grows to the height the child reports.
  await expect.poll(() => page.locator('iframe').evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(300);

  const input = fixtures.cases[0]!.userInput;
  const type = async (name: RegExp, id: string) => f.getByRole('textbox', { name }).fill(input[id]!);
  await type(/Invoice Amount/, 'd1000000-0000-4000-8000-000000000002');
  await type(/Billing Email/, 'd1000000-0000-4000-8000-000000000003');
  await type(/Billing Phone/, 'd1000000-0000-4000-8000-000000000004');
  await type(/Remarks/, 'd1000000-0000-4000-8000-000000000005');
  await type(/Vendor Code/, 'a1000000-0000-4000-8000-000000000002');
  await type(/Vendor Phone/, 'a1000000-0000-4000-8000-000000000004');
  await type(/Vendor Address/, 'a1000000-0000-4000-8000-000000000005');
  const pick = async (name: RegExp, label: string) =>
    f.getByRole('combobox', { name }).selectOption({ label }).catch(async () => {
      await f.getByRole('combobox', { name }).click();
      await f.getByRole('option', { name: label }).click();
    });
  await pick(/Currency/, input['d1000000-0000-4000-8000-000000000006']!);
  await pick(/Vendor Category/, input['a1000000-0000-4000-8000-000000000006']!);

  await expect.poll(async () => (await messages(page, 'change')).at(-1)?.payload).toEqual(fixtures.cases[0]!.expectedChange!.payload);

  // Submit as classic's handleSubmit does: await validate(), then getData().
  expect(await page.evaluate(() => (window as unknown as Harness).fpHost.validate())).toBe(true);
  const validated = (await messages(page, 'validated')).at(-1)!;
  expect(validated.payload).toEqual(fixtures.cases[0]!.expectedValidated.payload);
  expect(await page.evaluate(() => (window as unknown as Harness).fpHost.getData())).toEqual(fixtures.cases[0]!.expectedRecord);
  expect(cspViolations).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as Harness).fpWarnings)).toEqual([]);
});

test('classic host + fORM- child: an invalid form fails validate(), with the contract errors', async ({ page }) => {
  await openStep2(page, '/embed/dms-upload');
  await expect(page.getByTestId('formplus-host')).toHaveAttribute('aria-busy', 'false');
  const f = page.frameLocator('iframe[title="Document properties form"]');
  // The inputs the classic UI would take from the keyboard (the contract's invalid case holds more, e.g. an 11-digit phone and an impossible date, that the controls refuse to take or that need the stored record).
  await f.getByRole('textbox', { name: /Billing Email/ }).fill('bad@');
  await f.getByRole('textbox', { name: /Vendor Name/ }).fill('Acme 2');
  await f.getByRole('textbox', { name: /Vendor Email/ }).fill('');
  expect(await page.evaluate(() => (window as unknown as Harness).fpHost.validate())).toBe(false);
  const payload = (await messages(page, 'validated')).at(-1)!.payload as { valid: boolean; errors: Array<{ fieldId: string; code: string }> };
  expect(payload.valid).toBe(false);
  const wanted = fixtures.cases[1]!.expectedValidated.payload.errors.filter((e) =>
    ['invalid_email', 'pattern', 'required'].includes(e.code),
  );
  expect(wanted.length).toBeGreaterThan(0);
  for (const e of wanted) expect(payload.errors.map((x) => `${x.fieldId}:${x.code}`)).toContain(`${e.fieldId}:${e.code}`);
  await expect(f.getByText('This field is required.').first()).toBeVisible();
});

test('classic host + a child that never answers: after the 4 s handshake timeout the legacy renderer takes over with the record it had', async ({ page }) => {
  await openStep2(page, '/fp-silent.html');
  await expect(page.getByTestId('formplus-host')).toBeVisible();
  const started = Date.now();
  await expect(page.getByTestId('legacy-renderer')).toBeVisible({ timeout: 15_000 });
  const waited = Date.now() - started;
  expect(waited).toBeGreaterThan(2_500); // not before the 4 s timer (the page had already been running a moment)
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Harness).fpWarnings)).toContain('[formplus] fallback handshake_timeout');
  // The legacy form got the master record classic already held; nothing is lost.
  const shown = JSON.parse((await page.getByTestId('legacy-renderer').textContent()) ?? '{}') as Record<string, string>;
  expect(shown).toMatchObject({ 'Vendor Name': 'Acme Traders', 'Vendor Email': 'sales@acme.example', 'Onboarded On': '2026-04-01' });
  // Submit still works through the legacy handle.
  expect(await page.evaluate(() => (window as unknown as Harness).fpHost.validate())).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Harness).fpHost.getData())).toMatchObject({ 'Vendor Name': 'Acme Traders' });
});
