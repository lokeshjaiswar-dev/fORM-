import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ConsoleMessage, type Frame, type Page } from '@playwright/test';
import { CATEGORY, DIALOG, form, handshake, log, openParent, REQ, send, typeValidCase, v1, waitFor, windowLog } from './fixtures/bridge-v2.ts';

/*
 * T-58 (SEC-DESIGN 3.3, 10.3 row 58), Chromium AND Firefox (playwright.config.ts: the firefox project runs only this file).
 * The upload child in the real sandbox: a parent page frames the built child with `sandbox="allow-scripts allow-forms"` (no
 * allow-same-origin), and the page is also opened top-level. In both, the response carries the `sandbox` CSP, so the document has an
 * opaque origin: cookies, web storage and IndexedDB throw, nothing can be fetched, the form still renders from CORS-loaded assets,
 * and no CSP or CORS error reaches the console. Also: the built entry holds no fp-bridge/1 code and touches no browser storage API.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env['PW_PORT']) || 4173;
const ORIGIN = `http://localhost:${PORT}`;

/** Console noise that means a blocked resource, a refused script or a CORS failure, in either engine. */
const BAD = /content[- ]security[- ]policy|refused to|blocked|cors|cross-origin|failed to load|securityerror|not allowed/i;

function watch(page: Page) {
  const bad: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if ((m.type() === 'error' || m.type() === 'warning') && BAD.test(m.text())) bad.push(`${m.type()}: ${m.text()}`);
    else if (m.type() === 'error') bad.push(`error: ${m.text()}`);
  });
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => bad.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  return bad;
}

/** `securitypolicyviolation` events, per frame, from before any script of the page runs. */
const CSP_LISTENER = () => {
  (window as unknown as { __fpCsp: string[] }).__fpCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __fpCsp: string[] }).__fpCsp.push(`${e.effectiveDirective} ${e.blockedURI}`));
};
const violations = (frame: Frame) => frame.evaluate(() => (window as unknown as { __fpCsp?: string[] }).__fpCsp ?? []);

const childFrame = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.parentFrame() !== null);
  if (!frame) throw new Error('the child frame is not there');
  return frame;
};

/** What the page's own script can do in this document, as strings (a throw is `threw:<name>`). */
function probe() {
  const out: Record<string, string> = {};
  const attempt = async (name: string, fn: () => unknown) => {
    try {
      await fn();
      out[name] = 'ok';
    } catch (e) {
      out[name] = `threw:${(e as { name?: string }).name ?? 'Error'}`;
    }
  };
  return (async () => {
    await attempt('cookie', () => document.cookie);
    await attempt('localStorage', () => window.localStorage.getItem('x'));
    await attempt('sessionStorage', () => window.sessionStorage.getItem('x'));
    await attempt('indexedDB', () => {
      const db = window.indexedDB;
      if (!db) throw new TypeError('no indexedDB');
      db.open('fp-probe');
    });
    await attempt('fetch', async () => {
      await fetch('/api/dms/masters', { credentials: 'include' });
    });
    return { ...out, origin: self.origin, href: location.pathname };
  })();
}

test.beforeEach(async ({ page }) => void (await page.addInitScript(CSP_LISTENER)));

test.describe('framed with sandbox="allow-scripts allow-forms" (the classic host\'s way)', () => {
  test('the form renders in the opaque origin; cookie, storage and fetch are blocked; no CSP or CORS error', async ({ page }) => {
    const bad = watch(page);
    const embed = page.waitForResponse((r) => new URL(r.url()).pathname === '/embed/dms-upload');
    await openParent(page);
    const response = await embed;
    expect(response.headers()['content-security-policy']).toMatch(/^sandbox allow-scripts allow-forms; /);

    await handshake(page);
    const f = form(page);
    await expect(f.getByRole('heading', { name: 'Document details' })).toBeVisible();
    await expect(f.getByRole('heading', { name: 'Master details' })).toBeVisible();
    await expect(f.getByRole('textbox', { name: /Invoice No/ })).toHaveValue('INV-0007');
    // The fonts and the stylesheet came through CORS with Origin: null (a form without styles has no padding).
    await expect.poll(() => f.getByRole('heading', { name: 'Document details' }).evaluate((el) => getComputedStyle(el).fontSize)).not.toBe('32px');

    const frame = childFrame(page);
    expect(await violations(frame)).toEqual([]);
    const probed = await frame.evaluate(probe);
    expect(probed['origin']).toBe('null');
    expect(probed['cookie']).toMatch(/^threw:/);
    expect(probed['localStorage']).toMatch(/^threw:/);
    expect(probed['sessionStorage']).toMatch(/^threw:/);
    expect(probed['indexedDB']).not.toBe('ok');
    expect(probed['fetch']).toMatch(/^threw:/); // connect-src 'none'
    // The probes' own fetch is the only violation the page raised.
    expect(await violations(frame)).toEqual([expect.stringMatching(/^connect-src /)]);
    expect(bad.filter((m) => !/connect-src|fetch|\/api\/dms\/masters/i.test(m))).toEqual([]);
  });

  test('the form still works end to end in the sandbox: state while typing (no values), collected on collect, once per req', async ({ page }) => {
    const bad = watch(page);
    await openParent(page);
    await handshake(page);
    await typeValidCase(page);
    await expect.poll(async () => (await log(page)).filter((m) => m.type === 'state').at(-1)).toMatchObject({ dialogId: DIALOG, valid: true, dirty: true });

    const typed = Object.values(v1.cases[0]!.userInput);
    expect(JSON.stringify((await log(page)).filter((m) => m.type !== 'collected'))).not.toContain('accounts@acme.example');

    await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: REQ });
    const collected = await waitFor(page, 'collected');
    expect(collected).toMatchObject({ dialogId: DIALOG, req: REQ, valid: true, errors: [] });
    expect(collected['values']).toEqual(v1.cases[0]!.expectedValidated.payload.values);
    expect(collected['prefillHash']).toMatch(/^[0-9a-f]{16}$/);
    for (const value of typed) expect(JSON.stringify(collected)).toContain(JSON.stringify(value).slice(1, -1));

    await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: REQ });
    await page.waitForTimeout(500);
    expect((await log(page)).filter((m) => m.type === 'collected')).toHaveLength(1);
    expect(bad).toEqual([]);
  });

  test('only hello ever travels on the window: the child posts nothing else to its parent', async ({ page }) => {
    await openParent(page);
    await handshake(page);
    await typeValidCase(page);
    await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: REQ });
    await waitFor(page, 'collected');
    expect(await windowLog(page)).toEqual([{ protocol: 'fp-bridge/2', type: 'hello' }]);
  });

  test('a second port handover from the parent after the first is ignored', async ({ page }) => {
    await openParent(page);
    await handshake(page);
    await page.evaluate(() => (window as unknown as { fpSendSecondPort: () => void }).fpSendSecondPort());
    await page.evaluate(() => (window as unknown as { fpRoguePort: MessagePort }).fpRoguePort.postMessage({ protocol: 'fp-bridge/2', type: 'collect', dialogId: 'dlg-rogue', req: 'rogue-req-000000000001' }));
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { fpRogue: unknown[] }).fpRogue)).toEqual([]);
  });

  test('a sibling frame cannot hand the child a port before the real parent does (event.source is not window.parent)', async ({ page }) => {
    await openParent(page, { manual: true });
    await expect.poll(() => page.evaluate(() => (window as unknown as { fpHelloSeen: number }).fpHelloSeen)).toBe(1);
    await page.evaluate(() => {
      const rogue = document.createElement('iframe');
      document.body.appendChild(rogue);
      // From the sibling's own realm, so event.source in the child is that window, not the child's parent.
      (rogue.contentWindow as Window & { eval(code: string): unknown }).eval(`
        window.recv = [];
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => window.recv.push(e.data);
        window.top.frames[0].postMessage({ protocol: 'fp-bridge/2', type: 'port', dialogId: 'dlg-rogue' }, '*', [channel.port2]);
        window.rogueChannel = channel;
      `);
    });
    await page.waitForTimeout(500);
    // The rogue port was never taken: even an init sent on it gets no answer.
    await page.evaluate(() => {
      const rogue = document.querySelectorAll('iframe')[1]!.contentWindow as Window & { rogueChannel: MessageChannel };
      rogue.rogueChannel.port1.postMessage({ protocol: 'fp-bridge/2', type: 'collect', dialogId: 'dlg-rogue', req: 'rogue-req-000000000001' });
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (document.querySelectorAll('iframe')[1]!.contentWindow as Window & { recv: unknown[] }).recv)).toEqual([]);
    // The frame is alive and waiting: the real parent's handover is taken.
    await page.evaluate(() => (window as unknown as { fpHandover: () => void }).fpHandover());
    await handshake(page);
    await expect(form(page).getByRole('heading', { name: 'Document details' })).toBeVisible();
  });

  test('a secret that DMS holds is not in the page: empty, "Stored (hidden)", absent from collected until touched', async ({ page }) => {
    const VENDOR_CODE = 'a1000000-0000-4000-8000-000000000002';
    await openParent(page);
    const p = v1.handshake[1]!.payload as { masterFields: Array<Record<string, unknown>>; values: Record<string, string | null> };
    await handshake(page, {
      masterFields: p.masterFields.map((e) => (e['id'] === VENDOR_CODE ? { ...e, is_secret: true, required: false } : e)),
      values: { ...p.values, [VENDOR_CODE]: null },
      masked: [VENDOR_CODE],
    });
    const secret = form(page).getByRole('textbox', { name: /Vendor Code/ });
    await expect(secret).toHaveValue('');
    await expect(secret).toHaveAttribute('placeholder', 'Stored (hidden)');
    await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: 'e2e-req-0000000000002' });
    const first = await waitFor(page, 'collected');
    expect(first['values']).not.toHaveProperty(VENDOR_CODE);
    expect(JSON.stringify(await log(page))).not.toContain('\u2022\u2022\u2022\u2022\u2022\u2022');
    await secret.fill('2077');
    await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: 'e2e-req-0000000000003' });
    const second = await waitFor(page, 'collected', 1);
    expect(second['values'][VENDOR_CODE]).toBe('2077');
  });
});

test.describe('opened top-level (no parent)', () => {
  test('the response is sandboxed (opaque origin) even without a frame; the notice shows, nothing is exchanged; no errors', async ({ page }) => {
    const bad = watch(page);
    const response = await page.goto('/embed/dms-upload?fp_v=2');
    expect(response?.headers()['content-security-policy']).toMatch(/^sandbox allow-scripts allow-forms; /);
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    expect(response?.headers()['cache-control']).toBe('no-store');
    expect(response?.headers()['x-frame-options']).toBeUndefined();
    await expect(page.getByTestId('upload-notice')).toHaveAttribute('data-problem', 'not_framed');
    expect(await violations(page.mainFrame())).toEqual([]);
    const probed = await page.evaluate(probe);
    expect(probed['origin']).toBe('null');
    expect(probed['cookie']).toMatch(/^threw:/);
    expect(probed['localStorage']).toMatch(/^threw:/);
    expect(probed['sessionStorage']).toMatch(/^threw:/);
    expect(probed['fetch']).toMatch(/^threw:/);
    expect(bad.filter((m) => !/connect-src|fetch|\/api\/dms\/masters/i.test(m))).toEqual([]);
  });

  test('the response says what SEC-DESIGN 3.3 says: no network, nothing posted, explicit origins, no report endpoint', async ({ request }) => {
    const res = await request.get('/embed/dms-upload');
    const csp = res.headers()['content-security-policy'] ?? '';
    expect(res.status()).toBe(200);
    for (const part of ["default-src 'none'", `script-src 'self' ${ORIGIN}`, `style-src 'self' ${ORIGIN}`, `font-src 'self' ${ORIGIN}`, "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", `frame-ancestors 'self' ${ORIGIN}`, "require-trusted-types-for 'script'"]) {
      expect(csp.split('; '), part).toContain(part);
    }
    expect(csp).not.toMatch(/report-uri|report-to|allow-same-origin|unsafe-/);
    expect(res.headers()['reporting-endpoints']).toBeUndefined();
    // It is its own entry: not the SPA's index.
    const html = await res.text();
    expect(html).toContain('<title>Document properties form</title>');
    expect(html).toMatch(/assets\/embed-upload-[\w-]+\.js/);
    expect(html).not.toMatch(/assets\/main-/);
  });
});

test.describe('the built upload entry', () => {
  const dist = path.join(appRoot, 'dist');
  test.skip(!existsSync(path.join(dist, 'embed-upload.html')), 'needs the production build in dist/ (the webServer builds it)');

  /** Every file the entry loads at start: its html, scripts and modulepreloads, and the static imports of those, transitively. */
  function entryGraph(): Array<{ file: string; code: string }> {
    const seen = new Map<string, string>();
    const queue = [...readFileSync(path.join(dist, 'embed-upload.html'), 'utf8').matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
    while (queue.length > 0) {
      const rel = queue.pop()!;
      if (seen.has(rel)) continue;
      const code = readFileSync(path.join(dist, rel), 'utf8');
      seen.set(rel, code);
      for (const m of code.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)) queue.push(`assets/${m[1]!}`);
    }
    return [...seen].map(([file, code]) => ({ file, code }));
  }

  test('a default build has no fp-bridge/1 code in the upload entry (nor anywhere in dist)', () => {
    const graph = entryGraph();
    expect(graph.length).toBeGreaterThan(1);
    for (const { file, code } of graph) {
      expect(code, file).not.toContain('fp-bridge/1');
    }
    expect(graph.some(({ code }) => code.includes('fp-bridge/2'))).toBe(true);
  });

  test('the entry reaches no cookie, web storage, IndexedDB, history or beacon API (SEC-DESIGN 3.3 B1, B4, B6)', () => {
    for (const { file, code } of entryGraph()) {
      for (const api of ['document.cookie', 'localStorage', 'sessionStorage', 'indexedDB', 'history.pushState', 'history.replaceState', 'sendBeacon', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
        expect(code, `${file}: ${api}`).not.toContain(api);
      }
    }
  });
});

test('CATEGORY is the master dropdown the child asks the parent for', async ({ page }) => {
  await openParent(page);
  const { request } = await handshake(page);
  expect(request['fieldId']).toBe(CATEGORY);
  expect(request).toMatchObject({ type: 'options.request', parentValue: null, page: 1, search: '' });
});
