import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/*
 * Cross-repo conformance of fp-bridge/2 (T-INT): the REAL classic step 2 host (FormPlusHost, bridgeParentV2, bridgeProtocolV2,
 * legacyRecord, fieldsHandle and flag of the live `upload` module, bundled straight from the classic checkout) frames the REAL fORM-
 * /embed/dms-upload page from this build, in a browser, in the sandbox the host sets itself (allow-scripts allow-forms, an opaque origin,
 * one MessagePort). The contract fixtures are the oracle on both sides: the init classic builds, the answer fORM- gives in `collected`, the
 * record classic saves. Only classic's data layer is stood in for (the options endpoint and the legacy renderer the host falls back to).
 *
 * Needs the classic checkout with its node_modules: CLASSIC_DIR (on the build server: the materialised classic worktree of this lane).
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const classicDir = path.resolve(process.env['CLASSIC_DIR'] ?? path.resolve(appRoot, '../../../classic'));
const harnessDir = path.join(appRoot, 'e2e/fixtures/classic-host');
/* One output folder per worker process: beforeAll runs once in every worker, and a shared folder is emptied by the next build while another worker reads it. */
const outDir = path.join(appRoot, `node_modules/.tmp/classic-host-dist-${process.pid}`);
const fixtures = JSON.parse(readFileSync(path.join(appRoot, 'src/embed/bridge/__fixtures__/fp-bridge-v1.fixtures.json'), 'utf8')) as {
  cases: Array<{ userInput: Record<string, string>; expectedValidated: { payload: { valid: boolean; errors: Array<{ fieldId: string; code: string }>; values: Record<string, string> } }; expectedRecord?: Record<string, string> }>;
};
const HOST_PAGE = '<!doctype html><meta charset="utf-8"><title>classic step 2 (harness)</title><div id="root"></div><script src="/fp-classic-host.js"></script>';
/* A child that says hello and never takes the port: the host's handshake timeout. */
const SILENT_CHILD = '<!doctype html><meta charset="utf-8"><p>a child that never answers</p>';
/* A child that completes the handshake and answers initialized, but never answers a collect. */
const MUTE_CHILD = `<!doctype html><meta charset="utf-8"><p>a child that never collects</p><script>
  window.parent.postMessage({ protocol: 'fp-bridge/2', type: 'hello' }, '*');
  window.addEventListener('message', (e) => {
    const port = e.ports[0];
    if (!port) return;
    port.onmessage = (m) => {
      if (m.data && m.data.type === 'init') port.postMessage({ protocol: 'fp-bridge/2', type: 'initialized', dialogId: m.data.dialogId, fieldCount: 14, unsupported: [] });
    };
  });
</script>`;

type Msg = Record<string, any> & { type: string };
type Harness = {
  fpSent: Msg[];
  fpIn: Msg[];
  fpChannels: number;
  fpWarnings: string[];
  fpExpectedInit: (dialogId: string) => Msg;
  fpHost: { collect(): Promise<{ status: string; valid?: boolean; data?: Record<string, string> }> };
};

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

/** Mounts classic's step 2 on a page at this build's origin, with the child at `childUrl`. `query` selects edit mode / a stored secret in the harness entry. */
async function openStep2(page: Page, childUrl: string, query = '') {
  await page.clock.setFixedTime(new Date('2026-11-24T10:00:00')); // the fixtures' "today" is 24-11-2026
  await page.addInitScript((url) => ((window as unknown as { __FP_URL: string }).__FP_URL = url), childUrl);
  await page.route('**/fp-classic-parent.html**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: HOST_PAGE }));
  await page.route('**/fp-classic-host.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle }));
  await page.route('**/fp-silent.html**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: SILENT_CHILD }));
  await page.route('**/fp-mute.html**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: MUTE_CHILD }));
  await page.goto(`/fp-classic-parent.html${query}`);
}
const sent = (page: Page, type: string) => page.evaluate((t) => (window as unknown as Harness).fpSent.filter((m) => m && m.type === t), type);
const received = (page: Page, type: string) => page.evaluate((t) => (window as unknown as Harness).fpIn.filter((m) => m && m.type === t), type);
const collect = (page: Page) => page.evaluate(() => (window as unknown as Harness).fpHost.collect());

/** The valid case typed through the real form; `skip` names fields to leave alone (the stored secret). */
const typeValidCase = async (page: Page, skip: string[] = []) => {
  const f = page.frameLocator('iframe[title="Document properties form"]');
  const input = fixtures.cases[0]!.userInput;
  const type = async (name: RegExp, id: string) => (skip.includes(name.source) ? undefined : f.getByRole('textbox', { name }).fill(input[id]!));
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
};

test('classic host + fORM- child: hello -> port -> init -> options -> edits -> collect; payloads equal the contract', async ({ page }) => {
  const cspViolations: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && cspViolations.push(m.text()));
  await openStep2(page, '/embed/dms-upload');

  const host = page.getByTestId('formplus-host');
  await expect(host).toHaveAttribute('aria-busy', 'false'); // initialized arrived

  // The host framed the child as the contract says: a sandbox without allow-same-origin, no referrer, fp_v=2 and nothing else in the URL.
  const frame = page.locator('iframe[title="Document properties form"]');
  expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
  expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(new URL((await frame.getAttribute('src'))!, 'http://x').search).toBe('?fp_v=2');

  // The init classic builds from the document-form-builders response is the contract's shape; one channel was made for this mount.
  const [init] = await sent(page, 'init');
  expect(init).toEqual(await page.evaluate((id) => (window as unknown as Harness).fpExpectedInit(id), init!['dialogId']));
  expect(init).toMatchObject({ protocol: 'fp-bridge/2', masked: [], lookups: [], context: { mode: 'create', today: '24-11-2026' } });
  expect(await page.evaluate(() => (window as unknown as Harness).fpChannels)).toBe(1);
  expect((await received(page, 'initialized'))[0]).toEqual({ protocol: 'fp-bridge/2', type: 'initialized', dialogId: init!['dialogId'], fieldCount: 14, unsupported: [] });
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

  await typeValidCase(page);
  // Typing sends state (ids only), never a value, and nothing that looks like /1.
  await expect.poll(async () => (await received(page, 'state')).at(-1)).toMatchObject({ valid: true, dirty: true });
  expect(JSON.stringify((await received(page, 'state')))).not.toContain('accounts@acme.example');
  expect(await received(page, 'change')).toEqual([]);

  // Submit as classic's handleSubmit does: await collect().
  const result = await collect(page);
  expect(result).toEqual({ status: 'ok', valid: true, data: fixtures.cases[0]!.expectedRecord });
  const [collected] = await received(page, 'collected');
  expect(collected!['values']).toEqual(fixtures.cases[0]!.expectedValidated.payload.values);
  expect(collected).toMatchObject({ dialogId: init!['dialogId'], valid: true, errors: [] });
  expect(cspViolations).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as Harness).fpWarnings)).toEqual([]);
});

test('classic host + fORM- child: an invalid form is collected as valid:false (no data), with the contract errors shown in the frame', async ({ page }) => {
  await openStep2(page, '/embed/dms-upload');
  await expect(page.getByTestId('formplus-host')).toHaveAttribute('aria-busy', 'false');
  const f = page.frameLocator('iframe[title="Document properties form"]');
  // The inputs the classic UI would take from the keyboard (the contract's invalid case holds more, e.g. an 11-digit phone and an impossible date, that the controls refuse to take or that need the stored record).
  await f.getByRole('textbox', { name: /Billing Email/ }).fill('bad@');
  await f.getByRole('textbox', { name: /Vendor Name/ }).fill('Acme 2');
  await f.getByRole('textbox', { name: /Vendor Email/ }).fill('');
  expect(await collect(page)).toEqual({ status: 'ok', valid: false, data: {} });
  const [collected] = await received(page, 'collected');
  const wanted = fixtures.cases[1]!.expectedValidated.payload.errors.filter((e) => ['invalid_email', 'pattern', 'required'].includes(e.code));
  expect(wanted.length).toBeGreaterThan(0);
  for (const e of wanted) expect((collected!['errors'] as Array<{ fieldId: string; code: string }>).map((x) => `${x.fieldId}:${x.code}`)).toContain(`${e.fieldId}:${e.code}`);
  await expect(f.getByText('This field is required.').first()).toBeVisible();
});

test('classic host + fORM- child, edit mode: the stored secret is masked in the init, empty in the form, absent from the record until touched', async ({ page }) => {
  await openStep2(page, '/embed/dms-upload', '?edit=1&secret=Vendor%20Code');
  await expect(page.getByTestId('formplus-host')).toHaveAttribute('aria-busy', 'false');
  const [init] = await sent(page, 'init');
  const CODE = 'a1000000-0000-4000-8000-000000000002';
  expect(init!['context']).toMatchObject({ mode: 'edit' });
  expect(init!['values'][CODE]).toBeNull();
  expect(init!['masked']).toEqual([CODE]);
  expect(JSON.stringify(init)).not.toContain('••••••');
  expect(JSON.stringify(init)).not.toContain('1042'); // the stored value of the secret field never left classic

  const f = page.frameLocator('iframe[title="Document properties form"]');
  const secret = f.getByRole('textbox', { name: /Vendor Code/ });
  await expect(secret).toHaveValue('');
  await expect(secret).toHaveAttribute('placeholder', 'Stored (hidden)');

  // The rest of the required fields the stored record does not hold, typed; the secret is left alone.
  await typeValidCase(page, ['Vendor Code']);
  const untouched = await collect(page);
  expect(untouched).toMatchObject({ status: 'ok', valid: true });
  expect(untouched.data).not.toHaveProperty('Vendor Code'); // DMS keeps what it stores
  expect(untouched.data!['Vendor Name']).toBe('Acme Traders');
  expect(untouched.data!['Invoice Amount']).toBe('125000');

  await secret.fill('2077');
  const touched = await collect(page);
  expect(touched.data!['Vendor Code']).toBe('2077');
  expect(JSON.stringify(await received(page, 'state'))).not.toContain('2077');
});

test('classic host + a child that never answers hello (create): after the 4 s handshake timeout the legacy renderer takes over EMPTY', async ({ page }) => {
  await openStep2(page, '/fp-silent.html');
  await expect(page.getByTestId('formplus-host')).toBeVisible();
  const started = Date.now();
  await expect(page.getByTestId('legacy-renderer')).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - started).toBeGreaterThan(2_500); // not before the 4 s timer (the page had already been running a moment)
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Harness).fpWarnings)).toContain('[formplus] fallback handshake_timeout');
  // Create mode: no cached values exist any more: the legacy form starts empty, and submit still works through it.
  expect(JSON.parse((await page.getByTestId('legacy-renderer').textContent()) ?? 'null')).toEqual({});
  expect(await collect(page)).toEqual({ status: 'ok', valid: true, data: {} });
});

test('classic host + a child that never answers hello (edit): the legacy renderer is prefilled from DMS\'s stored, masked record, and the save keeps stored values and the secret mask out (BD-11)', async ({ page }) => {
  await openStep2(page, '/fp-silent.html', '?edit=1&secret=Vendor%20Code');
  await expect(page.getByTestId('legacy-renderer')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Harness).fpWarnings)).toContain('[formplus] fallback handshake_timeout');
  // Edit mode: an EMPTY form would save "" over every field the person left alone. DMS's own record (never a child value) prefills it.
  const shown = JSON.parse((await page.getByTestId('legacy-renderer').textContent()) ?? 'null') as Record<string, unknown>;
  expect(shown).toMatchObject({ 'Vendor Name': 'Acme Traders', 'Vendor Email': 'sales@acme.example', 'Onboarded On': '2026-04-01' });
  expect(shown['Vendor Code']).toBe('\u2022\u2022\u2022\u2022\u2022\u2022'); // the server mask, as flag-off shows it
  // The untouched legacy form (the stub returns what it was handed) is saved: stored values stay, the mask never goes back.
  const result = await collect(page);
  expect(result.status).toBe('ok');
  expect(result.valid).toBe(true);
  expect(result.data).toMatchObject({ 'Vendor Name': 'Acme Traders', 'Vendor Email': 'sales@acme.example', 'Onboarded On': '2026-04-01' });
  expect(result.data).not.toHaveProperty('Vendor Code');
  expect(JSON.stringify(result.data)).not.toContain('\u2022');
});

test('classic host + a child that completes the handshake but never collects: "timeout" after 8 s, the iframe stays, no fallback', async ({ page }) => {
  test.setTimeout(60_000);
  await openStep2(page, '/fp-mute.html');
  await expect(page.getByTestId('formplus-host')).toHaveAttribute('aria-busy', 'false');
  const started = Date.now();
  const result = await collect(page);
  expect(result).toEqual({ status: 'timeout' });
  expect(Date.now() - started).toBeGreaterThan(7_000);
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect(page.getByTestId('legacy-renderer')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Harness).fpWarnings)).toEqual([]);
});
