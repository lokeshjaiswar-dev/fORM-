import { expect, test } from '@playwright/test';
import { CATEGORY, DIALOG, REQ, form, handshake, initV2, log, openParent, PARENT_PAGE, send, typeValidCase, v1, waitFor } from './fixtures/bridge-v2.ts';

/*
 * /embed/dms-upload (T-FORM-2) over fp-bridge/2 in a real browser, framed by a tiny static parent page that stands in for the classic
 * live upload module (sandbox="allow-scripts allow-forms", one MessagePort), against the production build and its production headers.
 * The fixtures are the contract's 14-field form (the /1 fixture file, kept until M4): their fields and expected answers are the
 * oracle, now answered in `collected` (values only there, once per `collect`).
 */

const PORT = Number(process.env['PW_PORT']) || 4173;
const ORIGIN = `http://localhost:${PORT}`;
const csp = (page: import('@playwright/test').Page) => {
  const seen: string[] = [];
  page.on('console', (m) => /Content Security Policy|Content-Security-Policy|Refused to/i.test(m.text()) && seen.push(m.text()));
  return seen;
};

test.describe('framed by a parent page (the default allowlist is VITE_FP_EMBED_PARENTS = this origin)', () => {
  test('handshake, resize, options, edits, state and the collect round trip in the contract shape', async ({ page }) => {
    const violations = csp(page);
    await openParent(page);
    const { initialized, request } = await handshake(page);

    expect(initialized).toEqual({ protocol: 'fp-bridge/2', type: 'initialized', dialogId: DIALOG, fieldCount: 14, unsupported: [] });
    expect(request).toMatchObject({ protocol: 'fp-bridge/2', type: 'options.request', fieldId: CATEGORY, parentValue: null, page: 1, search: '' });
    expect(request['id']).toMatch(/^c-o-/);

    // Two titled sections, the increment field read-only, and the iframe grows to the form's height.
    const f = form(page);
    await expect(f.getByRole('heading', { name: 'Document details' })).toBeVisible();
    await expect(f.getByRole('heading', { name: 'Master details' })).toBeVisible();
    await expect(f.getByRole('textbox', { name: /Invoice No/ })).toHaveValue('INV-0007');
    await expect(f.getByRole('textbox', { name: /Invoice No/ })).toHaveAttribute('readonly', '');
    await expect.poll(async () => (await log(page)).filter((m) => m.type === 'resize').at(-1)?.['height'] ?? 0).toBeGreaterThan(300);
    await expect.poll(() => page.locator('#child').evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(300);

    await typeValidCase(page);
    await expect.poll(async () => (await log(page)).filter((m) => m.type === 'state').at(-1)).toMatchObject({ valid: true, dirty: true });
    // `state` is ids only: nothing the person typed travelled before the collect.
    expect(JSON.stringify((await log(page)).filter((m) => m.type === 'state'))).not.toContain('Acme');
    expect((await log(page)).some((m) => m.type === 'change' || m.type === 'validated')).toBe(false);

    await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: REQ });
    const collected = await waitFor(page, 'collected');
    expect(collected).toMatchObject({ protocol: 'fp-bridge/2', type: 'collected', dialogId: DIALOG, req: REQ, valid: v1.cases[0]!.expectedValidated.payload.valid, errors: [] });
    expect(collected['values']).toEqual(v1.cases[0]!.expectedValidated.payload.values);
    expect(violations).toEqual([]);
  });

  test('an invalid form: errors by field id and code, values as typed, inline errors shown in the frame', async ({ page }) => {
    await openParent(page);
    // The number control does not take a "." from the keyboard, so a fractional amount can only arrive in the stored record.
    const values = { ...(v1.handshake[1]!.payload['values'] as Record<string, string>), 'd1000000-0000-4000-8000-000000000002': '12.5' };
    await handshake(page, { values });
    const f = form(page);
    await expect(f.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme Traders');
    await f.getByRole('textbox', { name: /Vendor Name/ }).fill('Acme 2');
    await f.getByRole('textbox', { name: /Billing Email/ }).fill('bad@');
    await f.getByRole('textbox', { name: /Vendor Email/ }).fill('');

    await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: REQ });
    const collected = await waitFor(page, 'collected');
    expect(collected['valid']).toBe(false);
    const codes = (collected['errors'] as Array<{ fieldId: string; code: string }>).map((e) => `${e.fieldId}:${e.code}`);
    for (const want of [
      'd1000000-0000-4000-8000-000000000002:not_integer',
      'd1000000-0000-4000-8000-000000000003:invalid_email',
      'a1000000-0000-4000-8000-000000000001:pattern',
      'a1000000-0000-4000-8000-000000000003:required',
    ]) expect(codes).toContain(want);
    expect(collected['values']['d1000000-0000-4000-8000-000000000002']).toBe('12.5');
    expect(collected['values']['a1000000-0000-4000-8000-000000000001']).toBe('Acme 2');
    await expect(f.getByText('This field is required.').first()).toBeVisible();
  });

  test('a re-sent init replaces the form (same page, one answer per init)', async ({ page }) => {
    await openParent(page);
    await handshake(page);
    const f = form(page);
    await f.getByRole('textbox', { name: /Vendor Name/ }).fill('Typed over');
    await send(page, initV2({ values: { 'a1000000-0000-4000-8000-000000000001': 'Second Vendor' } }));
    await expect(f.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Second Vendor');
    expect((await log(page)).filter((m) => m.type === 'initialized')).toHaveLength(2);
    await expect(f.getByRole('heading', { name: 'Document details' })).toHaveCount(1);
  });

  test('a doctype with a type outside the seven: initialized names it and no form is shown', async ({ page }) => {
    await openParent(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { fpPortReady: boolean }).fpPortReady)).toBe(true);
    await send(page, initV2({ doctypeFields: [{ id: 'd2000000-0000-4000-8000-000000000001', type: 'checkboxes', label: '', value: 'Flags', required: false }], masterFields: [], values: {} }));
    const initialized = await waitFor(page, 'initialized');
    expect(initialized).toMatchObject({ fieldCount: 1, unsupported: ['d2000000-0000-4000-8000-000000000001'] });
    await expect(form(page).getByRole('textbox')).toHaveCount(0);
  });

  test('an init or a collect for another dialog is ignored', async ({ page }) => {
    await openParent(page);
    await handshake(page);
    await send(page, initV2({ dialogId: 'dlg-other', values: { 'a1000000-0000-4000-8000-000000000001': 'Other Dialog' } }));
    await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: 'dlg-other', req: REQ });
    await page.waitForTimeout(500);
    await expect(form(page).getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme Traders');
    expect((await log(page)).filter((m) => m.type === 'collected')).toHaveLength(0);
    expect((await log(page)).filter((m) => m.type === 'initialized')).toHaveLength(1);
  });

  test('a message with a key the contract does not know is dropped: no token rides along', async ({ page }) => {
    await openParent(page);
    await handshake(page);
    await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: REQ, token: 'bearer-canary' });
    await send(page, { protocol: 'fp-bridge/1', type: 'validate', id: 'p-val-1', payload: {} });
    await page.waitForTimeout(500);
    expect((await log(page)).filter((m) => m.type === 'collected' || m.type === 'validated')).toHaveLength(0);
  });
});

test.describe('what the page refuses', () => {
  test('opened on its own (not framed): says to open it from DMS', async ({ page }) => {
    await page.goto('/embed/dms-upload?fp_v=2');
    await expect(page.getByTestId('upload-notice')).toHaveAttribute('data-problem', 'not_framed');
  });

  test('framed from a page on another origin: the browser refuses the frame (frame-ancestors), nothing is exchanged', async ({ page }) => {
    // Same server, other origin (127.0.0.1 is not localhost): not in VITE_FP_EMBED_PARENTS.
    await page.route(`http://127.0.0.1:${PORT}/fp-parent.html**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PARENT_PAGE }));
    await page.goto(`http://127.0.0.1:${PORT}/fp-parent.html?childOrigin=${encodeURIComponent(ORIGIN)}`);
    // The browser shows its error page in the frame instead of the app; the page never says hello.
    await expect.poll(() => page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url())).toEqual(['chrome-error://chromewebdata/']);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { fpWindowLog: unknown[] }).fpWindowLog)).toEqual([]);
  });

  test('the other routes still refuse framing', async ({ page }) => {
    const refused: string[] = [];
    page.on('console', (m) => /frame-ancestors|Refused to frame/i.test(m.text()) && refused.push(m.text()));
    await page.route('**/fp-frame.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<iframe src="/forms"></iframe>' }));
    await page.goto('/fp-frame.html');
    await expect.poll(() => refused.length).toBeGreaterThan(0);
  });

  test('response headers: only /embed/dms-upload is framable (sandboxed, by the listed parent), every other route, /embed/dms-master included, is DENY', async ({ request }) => {
    const embed = await request.get('/embed/dms-upload');
    expect(embed.headers()['content-security-policy']).toContain(`frame-ancestors 'self' ${ORIGIN}`);
    expect(embed.headers()['content-security-policy']).toMatch(/^sandbox allow-scripts allow-forms; /);
    expect(embed.headers()['x-frame-options']).toBeUndefined();
    for (const url of ['/forms', '/embed/dms-master', '/embed/dms-upload/x', '/embed/dms-upload/..%2Fdms-master']) {
      const other = await request.get(url);
      expect(other.headers()['content-security-policy'], url).toContain("frame-ancestors 'none'");
      expect(other.headers()['x-frame-options'], url).toBe('DENY');
    }
  });
});
