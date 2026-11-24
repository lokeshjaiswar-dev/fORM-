import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

/*
 * /embed/dms-upload (T-FORM-2) in a real browser, framed by a tiny static parent page, against the production build and
 * its production CSP. The parent page stands in for the classic upload step 2: it frames the child, logs every message
 * and sends what the test asks. The fixtures are the contract's (fp-bridge-v1.fixtures.json).
 */

const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL('../src/embed/bridge/__fixtures__/fp-bridge-v1.fixtures.json', import.meta.url)), 'utf8')) as {
  handshake: Array<{ payload: Record<string, unknown> }>;
  optionsExchange: Array<{ payload: Record<string, unknown> }>;
  cases: Array<{ userInput: Record<string, string>; expectedValidated: { payload: { valid: boolean; errors: Array<{ fieldId: string; code: string }>; values: Record<string, string> } }; expectedChange?: { payload: unknown } }>;
};
const PARENT_PAGE = readFileSync(fileURLToPath(new URL('./fixtures/dms-upload-parent.html', import.meta.url)), 'utf8');
const ORIGIN = 'http://localhost:4173';
const CATEGORY = 'a1000000-0000-4000-8000-000000000006';

type Msg = { type: string; id: string; replyTo?: string; payload: Record<string, any> };

async function openParent(page: Page, query = '') {
  await page.route('**/fp-parent.html**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PARENT_PAGE }));
  await page.goto(`/fp-parent.html${query}`);
}
const log = (page: Page) => page.evaluate(() => (window as unknown as { fpLog: Msg[] }).fpLog);
const send = (page: Page, message: unknown) => page.evaluate((m) => (window as unknown as { fpSend: (m: unknown) => void }).fpSend(m), message);
const waitFor = async (page: Page, type: string, nth = 0): Promise<Msg> => {
  await expect.poll(async () => (await log(page)).filter((m) => m.type === type).length, { message: `waiting for ${type}` }).toBeGreaterThan(nth);
  return (await log(page)).filter((m) => m.type === type)[nth]!;
};

/** The handshake as the classic side does it: wait for `ready`, send `init`, answer the options request. */
async function handshake(page: Page, over: Record<string, unknown> = {}, id = 'p-init-1') {
  await waitFor(page, 'ready');
  await send(page, { protocol: 'fp-bridge/1', type: 'init', id, payload: { ...fixtures.handshake[1]!.payload, ...over } });
  const initialized = await waitFor(page, 'initialized');
  const request = await waitFor(page, 'options.request');
  await send(page, { protocol: 'fp-bridge/1', type: 'options.result', id: 'p-opt-1', replyTo: request.id, payload: fixtures.optionsExchange[1]!.payload });
  return { initialized, request };
}

const form = (page: Page): FrameLocator => page.frameLocator('#child');

test.describe('framed by a parent page on the same origin (the default allowlist)', () => {
  test('handshake, resize, options, edits and the validate round trip in the contract shape', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => m.text().includes('Content Security Policy') && violations.push(m.text()));
    await openParent(page);
    const { initialized, request } = await handshake(page);

    const ready = (await log(page)).find((m) => m.type === 'ready')!;
    expect(ready.payload).toEqual({ version: '1', capabilities: ['options', 'readOnly'] });
    expect(initialized.replyTo).toBe('p-init-1');
    expect(initialized.payload).toEqual({ fieldCount: 14, unsupported: [] });
    expect(request.payload).toEqual({ fieldId: CATEGORY, parentValue: null, page: 1, search: '' });

    // Two titled sections, the increment field read-only, and the iframe grows to the form's height.
    const f = form(page);
    await expect(f.getByRole('heading', { name: 'Document details' })).toBeVisible();
    await expect(f.getByRole('heading', { name: 'Master details' })).toBeVisible();
    await expect(f.getByRole('textbox', { name: /Invoice No/ })).toHaveValue('INV-0007');
    await expect(f.getByRole('textbox', { name: /Invoice No/ })).toHaveAttribute('readonly', '');
    await expect.poll(async () => (await log(page)).filter((m) => m.type === 'resize').at(-1)?.payload['height'] ?? 0).toBeGreaterThan(300);
    await expect.poll(() => page.locator('#child').evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(300);

    // The valid case: type what the fixture's user typed.
    const input = fixtures.cases[0]!.userInput;
    await f.getByRole('textbox', { name: /Invoice Amount/ }).fill(input['d1000000-0000-4000-8000-000000000002']!);
    await f.getByRole('textbox', { name: /Billing Email/ }).fill(input['d1000000-0000-4000-8000-000000000003']!);
    await f.getByRole('textbox', { name: /Billing Phone/ }).fill(input['d1000000-0000-4000-8000-000000000004']!);
    await f.getByRole('textbox', { name: /Remarks/ }).fill(input['d1000000-0000-4000-8000-000000000005']!);
    await f.getByRole('textbox', { name: /Vendor Code/ }).fill(input['a1000000-0000-4000-8000-000000000002']!);
    await f.getByRole('textbox', { name: /Vendor Phone/ }).fill(input['a1000000-0000-4000-8000-000000000004']!);
    await f.getByRole('textbox', { name: /Vendor Address/ }).fill(input['a1000000-0000-4000-8000-000000000005']!);
    await f.getByRole('combobox', { name: /Currency/ }).selectOption({ label: 'INR' }).catch(async () => {
      await f.getByRole('combobox', { name: /Currency/ }).click();
      await f.getByRole('option', { name: 'INR' }).click();
    });
    await f.getByRole('combobox', { name: /Vendor Category/ }).selectOption({ label: 'Wholesale' }).catch(async () => {
      await f.getByRole('combobox', { name: /Vendor Category/ }).click();
      await f.getByRole('option', { name: 'Wholesale' }).click();
    });

    await expect.poll(async () => (await log(page)).filter((m) => m.type === 'change').at(-1)?.payload).toEqual(fixtures.cases[0]!.expectedChange!.payload);

    await send(page, { protocol: 'fp-bridge/1', type: 'validate', id: 'p-val-1', payload: {} });
    const validated = await waitFor(page, 'validated');
    expect(validated.replyTo).toBe('p-val-1');
    expect(validated.payload).toEqual(fixtures.cases[0]!.expectedValidated.payload);
    expect(violations).toEqual([]);
  });

  test('an invalid form: errors by field id and code, values as typed, inline errors shown in the frame', async ({ page }) => {
    await openParent(page);
    // The number control does not take a "." from the keyboard, so a fractional amount can only arrive in the stored record.
    await handshake(page, { values: { ...(fixtures.handshake[1]!.payload['values'] as Record<string, string>), 'd1000000-0000-4000-8000-000000000002': '12.5' } });
    const f = form(page);
    await expect(f.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme Traders');
    await f.getByRole('textbox', { name: /Vendor Name/ }).fill('Acme 2');
    await f.getByRole('textbox', { name: /Billing Email/ }).fill('bad@');
    await f.getByRole('textbox', { name: /Vendor Email/ }).fill('');

    await send(page, { protocol: 'fp-bridge/1', type: 'validate', id: 'p-val-2', payload: {} });
    const validated = await waitFor(page, 'validated');
    expect(validated.replyTo).toBe('p-val-2');
    expect(validated.payload.valid).toBe(false);
    const codes = (validated.payload.errors as Array<{ fieldId: string; code: string }>).map((e) => `${e.fieldId}:${e.code}`);
    for (const want of [
      'd1000000-0000-4000-8000-000000000002:not_integer',
      'd1000000-0000-4000-8000-000000000003:invalid_email',
      'a1000000-0000-4000-8000-000000000001:pattern',
      'a1000000-0000-4000-8000-000000000003:required',
    ]) expect(codes).toContain(want);
    expect(validated.payload.values['d1000000-0000-4000-8000-000000000002']).toBe('12.5');
    expect(validated.payload.values['a1000000-0000-4000-8000-000000000001']).toBe('Acme 2');
    await expect(f.getByText('This field is required.').first()).toBeVisible();
  });

  test('a re-sent init replaces the form (same page, one answer per init)', async ({ page }) => {
    await openParent(page);
    await handshake(page);
    const f = form(page);
    await f.getByRole('textbox', { name: /Vendor Name/ }).fill('Typed over');
    await send(page, { protocol: 'fp-bridge/1', type: 'init', id: 'p-init-2', payload: { ...fixtures.handshake[1]!.payload, values: { 'a1000000-0000-4000-8000-000000000001': 'Second Vendor' } } });
    await expect(f.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Second Vendor');
    const inits = (await log(page)).filter((m) => m.type === 'initialized');
    expect(inits.map((m) => m.replyTo)).toEqual(['p-init-1', 'p-init-2']);
    await expect(f.getByRole('heading', { name: 'Document details' })).toHaveCount(1);
  });

  test('a doctype with a type outside the seven: initialized names it and no form is shown', async ({ page }) => {
    await openParent(page);
    await waitFor(page, 'ready');
    await send(page, {
      protocol: 'fp-bridge/1', type: 'init', id: 'p-init-u',
      payload: { ...fixtures.handshake[1]!.payload, doctypeFields: [{ id: 'd2000000-0000-4000-8000-000000000001', type: 'checkboxes', label: '', value: 'Flags', required: false }], masterFields: [], values: {} },
    });
    const initialized = await waitFor(page, 'initialized');
    expect(initialized.payload).toEqual({ fieldCount: 1, unsupported: ['d2000000-0000-4000-8000-000000000001'] });
    await expect(form(page).getByRole('textbox')).toHaveCount(0);
  });

  test('a message the page did not send never reaches the form: a stray window cannot init it', async ({ page }) => {
    await openParent(page);
    await waitFor(page, 'ready');
    await page.evaluate((m) => {
      // A second same-origin iframe posts to the child from its own realm: event.source is that window, not the child's parent.
      const rogue = document.createElement('iframe');
      document.body.appendChild(rogue);
      (rogue.contentWindow as Window & { eval(code: string): unknown }).eval(`window.top.frames[0].postMessage(${JSON.stringify(m)}, ${JSON.stringify(location.origin)})`);
    }, { protocol: 'fp-bridge/1', type: 'init', id: 'rogue-1', payload: fixtures.handshake[1]!.payload });
    await page.waitForTimeout(500);
    expect((await log(page)).filter((m) => m.type === 'initialized')).toHaveLength(0);
    await expect(form(page).getByRole('heading', { name: 'Document details' })).toHaveCount(0);
    // The frame is alive: the real parent's init is taken.
    await send(page, { protocol: 'fp-bridge/1', type: 'init', id: 'p-init-1', payload: fixtures.handshake[1]!.payload });
    await waitFor(page, 'initialized');
    await expect(form(page).getByRole('heading', { name: 'Document details' })).toBeVisible();
  });
});

test.describe('what the page refuses', () => {
  test('opened with a parent origin that is not on the allowlist: a notice, no message ever sent', async ({ page }) => {
    await openParent(page, '?parent=https%3A%2F%2Fevil.example');
    await expect(form(page).getByTestId('upload-notice')).toHaveAttribute('data-problem', 'not_allowed');
    await page.waitForTimeout(500);
    expect(await log(page)).toEqual([]);
  });

  test('opened on its own (not framed): says to open it from DMS', async ({ page }) => {
    await page.goto(`/embed/dms-upload?fp_parent=${encodeURIComponent(ORIGIN)}&fp_v=1`);
    await expect(page.getByTestId('upload-notice')).toHaveAttribute('data-problem', 'not_framed');
  });

  test('framed from a page on another origin: the browser refuses the frame (frame-ancestors), nothing is exchanged', async ({ page }) => {
    // Same server, other origin (127.0.0.1 is not localhost): not on the child's allowlist.
    await page.route('http://127.0.0.1:4173/fp-parent.html**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PARENT_PAGE }));
    await page.goto(`http://127.0.0.1:4173/fp-parent.html?childOrigin=${encodeURIComponent(ORIGIN)}&parent=${encodeURIComponent('http://127.0.0.1:4173')}`);
    // The browser shows its error page in the frame instead of the app; the page never says ready.
    await expect.poll(() => page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url())).toEqual(['chrome-error://chromewebdata/']);
    await page.waitForTimeout(500);
    expect(await log(page)).toEqual([]);
  });

  test('the other routes still refuse framing', async ({ page }) => {
    const refused: string[] = [];
    page.on('console', (m) => /frame-ancestors|Refused to frame/i.test(m.text()) && refused.push(m.text()));
    await page.route('**/fp-frame.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<iframe src="/forms"></iframe>' }));
    await page.goto('/fp-frame.html');
    await expect.poll(() => refused.length).toBeGreaterThan(0);
  });

  test('response headers: only /embed/dms-upload is framable (by the page itself by default), every other route, /embed/dms-master included, is DENY', async ({ request }) => {
    const embed = await request.get('/embed/dms-upload');
    expect(embed.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(embed.headers()['x-frame-options']).toBeUndefined();
    for (const url of ['/forms', '/embed/dms-master']) {
      const other = await request.get(url);
      expect(other.headers()['content-security-policy'], url).toContain("frame-ancestors 'none'");
      expect(other.headers()['x-frame-options'], url).toBe('DENY');
    }
  });
});
