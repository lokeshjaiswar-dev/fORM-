import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { RETURN, stubDms, type DmsStub, type SessionRequest } from './support/dmsLaunch.ts';

/*
 * T-DMSINT-55 (SEC-DESIGN 10.3), production build under its production CSP (run through ~/bin/pw-gate): fORM- never reads what DMS keeps
 * for the user. The cookies `token`, `Authorization` and `access_token` and `localStorage.token` hold a canary; `document.cookie` and
 * `Storage.getItem` are instrumented by an init script. Across a full master flow and a full record flow: no request to DMS carries the
 * canary (URL, header, body), the cookie getter is never called and `localStorage.getItem('token')` never is, and the session credential
 * is in no URL, storage or window property. Also: the default bundle contains no cookie reader, and a `#fp=` link is refused.
 *
 * The M2 build (VITE_FP_LEGACY_DESCRIPTOR=1) still launches a `#fp=` descriptor: run this file with
 * `FP_LEGACY_BUILD=1 VITE_FP_LEGACY_DESCRIPTOR=1 ... -g "M2 build"` (the build the web server makes inherits the variable).
 */

const LEGACY = process.env['FP_LEGACY_BUILD'] === '1';
const CANARY = 'CANARY-7f3a9c41-not-for-dms';
const MASTER = 'b9000000-0000-4000-8000-000000000001';
const fixtures = JSON.parse(readFileSync(new URL('../src/embed/record/__fixtures__/dms-record.fixtures.json', import.meta.url), 'utf8'));
const RECORD = fixtures.descriptor.edit.recordId as string;
const RECORD_MASTER = fixtures.descriptor.edit.masterId as string;
/** The names the DMS frontends keep the user's token under (cookies, localStorage): fORM- reads none of them, in either storage. */
const DMS_KEYS = new Set(['token', 'Authorization', 'authorization', 'access_token']);
const dmsKeyReads = (storage: string[]) => storage.filter((k) => DMS_KEYS.has(k.slice(k.indexOf(':') + 1)));

const created = { status: 201, body: { success: true, data: { id: MASTER, name: 'Vendor', source: 'formplus', updated_at: 'T1' } } };

function answer(req: SessionRequest) {
  if (req.method === 'POST' && req.route === 'master/form') return created;
  if (req.method === 'GET' && req.legacy === fixtures.loadMaster.request.path) return { status: 200, body: fixtures.loadMaster.response.body };
  if (req.method === 'GET' && req.legacy === fixtures.loadRecord.request.path) return { status: 200, body: fixtures.loadRecord.response.body };
  if (req.method === 'PATCH' && req.legacy === fixtures.update.request.path) return { status: 200, body: fixtures.update.response.body };
  return undefined;
}

/** The canaries DMS frontends keep, and the instruments that count reads. Runs before any page script. */
async function plantCanaries(page: Page) {
  await page.addInitScript((canary) => {
    const w = window as unknown as { __cookieReads: number; __storageReads: string[] };
    w.__cookieReads = 0;
    w.__storageReads = [];
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      enumerable: desc.enumerable,
      get(this: Document) {
        w.__cookieReads += 1;
        return desc.get!.call(this) as string;
      },
      set(this: Document, v: string) {
        desc.set!.call(this, v);
      },
    });
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (this: Storage, key: string) {
      w.__storageReads.push(`${this === window.localStorage ? 'local' : 'session'}:${key}`);
      return getItem.call(this, key);
    };
    for (const name of ['token', 'Authorization', 'access_token']) document.cookie = `${name}=${canary}; path=/`;
    window.localStorage.setItem('token', canary);
  }, CANARY);
}

async function reads(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __cookieReads: number; __storageReads: string[] };
    return { cookie: w.__cookieReads, storage: w.__storageReads };
  });
}

/** Nothing the page keeps or shows holds the credential. */
async function expectNoCredentialAnywhere(page: Page) {
  expect(page.url()).not.toContain('fps1_');
  const where = await page.evaluate(() => {
    const hits: string[] = [];
    const credential = /fps1_[A-Za-z0-9_-]{43}/;
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)!;
        if (credential.test(key) || credential.test(Storage.prototype.getItem.call(store, key) ?? '')) hits.push(`${store === localStorage ? 'local' : 'session'}:${key}`);
      }
    }
    for (const key of Object.getOwnPropertyNames(window)) {
      try {
        const v = (window as unknown as Record<string, unknown>)[key];
        if (typeof v === 'string' && credential.test(v)) hits.push(`window.${key}`);
      } catch {
        /* a cross-origin frame property */
      }
    }
    if (credential.test(document.documentElement.outerHTML)) hits.push('document');
    return hits;
  });
  expect(where).toEqual([]);
}

function expectCleanTraffic(dms: DmsStub) {
  expect(dms.haystack()).not.toContain(CANARY);
  expect(dms.violations).toEqual([]);
  const session = dms.sessionRequests();
  expect(session.length).toBeGreaterThan(0);
  for (const r of session) expect(r.headers['authorization']).toMatch(/^Bearer fps1_[A-Za-z0-9_-]{43}$/);
  expect(dms.exchanges.length).toBe(1);
  expect(dms.exchanges.every((e) => e.ok && !e.hadAuthorization)).toBe(true);
}

test('T-55 master flow: the canaries are never read or sent; the credential is in no storage, URL or window property', async ({ page }) => {
  test.skip(LEGACY, 'the M2 build reads the token on purpose (legacy descriptor launches only)');
  const dms = await stubDms(page, { answer });
  const violations: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && violations.push(m.text()));
  // A keepalive request sent while the page unloads is not interceptable by route() and not reported as a request event; the fetch call
  // itself is, from an init script that leaves a note in localStorage (a synchronous write survives the unload).
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') localStorage.setItem('__leave', JSON.stringify({ url: String(input), keepalive: init.keepalive === true, bearer: /^Bearer fps1_[A-Za-z0-9_-]{43}$/.test(String((init.headers as Record<string, string> | undefined)?.['Authorization'] ?? '')) }));
      return original(input, init);
    };
  });
  await plantCanaries(page);

  await dms.launch(page, dms.issue({ mode: 'dms-master', seed: { name: 'Vendor', doctype_ids: [], folder_ids: [], classification: null } }));
  const palette = page.getByRole('complementary').first();
  await palette.getByRole('button', { name: 'Email' }).click();
  await expect(page.getByTestId('dms-master-builder')).toBeVisible();

  const before = await reads(page);
  expect(before.cookie).toBe(0);
  expect(before.storage).not.toContain('local:token');
  expect(dmsKeyReads(before.storage)).toEqual([]);
  expect(before.storage).toContain('session:fp.lv'); // the verifier handed over by the DMS page, read once
  await expectNoCredentialAnywhere(page);

  await page.getByRole('button', { name: 'Save to DMS' }).click();
  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?fp_status=saved&fp_master_id=${MASTER}`);
  expectCleanTraffic(dms);
  // Leaving ends the session on the server: DELETE s/session, called on pagehide with keepalive and the credential, to the session route only.
  const leave = JSON.parse((await page.evaluate(() => localStorage.getItem('__leave'))) ?? 'null') as { url: string; keepalive: boolean; bearer: boolean } | null;
  expect(leave).toEqual({ url: 'http://localhost:4173/api/dms/v1/formplus/s/session', keepalive: true, bearer: true });
  expect(violations).toEqual([]);
});

test('T-55 leaving: pagehide sends DELETE s/session with the credential, and the page then offers Reconnect (a back-forward restore)', async ({ page }) => {
  test.skip(LEGACY, 'the M2 build has no session');
  const dms = await stubDms(page, { answer });
  await dms.launch(page, dms.issue({ mode: 'dms-master', seed: { name: 'Vendor', doctype_ids: [], folder_ids: [], classification: null } }));
  await expect(page.getByTestId('dms-master-builder')).toBeVisible();
  // pagehide without leaving, so the request can be observed: this is what a bfcache entry sees.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => dms.requests.filter((r) => r.method === 'DELETE').length).toBe(1);
  const leave = dms.requests.find((r) => r.method === 'DELETE')!;
  expect(leave.path).toBe('/api/dms/v1/formplus/s/session');
  expect(leave.headers['authorization']).toMatch(/^Bearer fps1_[A-Za-z0-9_-]{43}$/);
  await expect(page.getByTestId('fp-reconnect-banner')).toBeVisible();
  expect(dms.violations).toEqual([]);
});

test('T-55 record flow: the canaries are never read or sent', async ({ page }) => {
  test.skip(LEGACY, 'the M2 build reads the token on purpose (legacy descriptor launches only)');
  const dms = await stubDms(page, { answer });
  await plantCanaries(page);

  await dms.launch(page, dms.issue({ mode: 'dms-record', masterId: RECORD_MASTER, recordId: RECORD, seed: null }));
  await expect(page.getByRole('textbox', { name: /Vendor Name/ })).toHaveValue('Acme');
  const before = await reads(page);
  expect(before.cookie).toBe(0);
  expect(dmsKeyReads(before.storage)).toEqual([]);
  await expectNoCredentialAnywhere(page);

  await page.getByRole('combobox', { name: /Tier/ }).selectOption('Silver');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('back in DMS')).toBeVisible();
  expectCleanTraffic(dms);
  expect(dms.sessionRequests().some((r) => r.method === 'PATCH')).toBe(true);
});

test('T-55 bundle: the default production build contains no cookie reader and no token name', async ({ page }) => {
  test.skip(LEGACY, 'the M2 build contains the legacy chunk on purpose');
  await page.goto('/embed/dms-master');
  const scripts = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\.js(\?|$)/.test(e.name)).map((e) => e.name));
  expect(scripts.length).toBeGreaterThan(0);
  const markers = ['document.cookie', 'access_token'];
  for (const url of scripts) {
    const text = await (await page.request.get(url)).text();
    for (const marker of markers) expect(text.includes(marker), `${marker} in ${url}`).toBe(false);
  }
  // No separate legacy chunk is even published.
  const index = await (await page.request.get('/')).text();
  expect(index).not.toMatch(/legacy/i);
});

test('T-52 in the browser: a #fp= link is no longer supported, and sends nothing', async ({ page }) => {
  test.skip(LEGACY, 'the M2 build still accepts #fp=');
  const dms = await stubDms(page, { answer });
  await plantCanaries(page);
  const descriptor = Buffer.from(JSON.stringify({ v: 1, mode: 'dms-master', profile: 'dms-v1', tenantId: 'acme', workspaceId: 'ws_1', returnUrl: RETURN, apiBase: 'http://localhost:4173/api' })).toString('base64url');
  await page.goto(`/embed/dms-master#fp=${descriptor}`);
  await expect(page.getByText('This link is no longer supported. Open the form again from DMS.')).toBeVisible();
  expect(page.url()).not.toContain('fp=');
  expect(dms.requests).toHaveLength(0);
  expect((await reads(page)).cookie).toBe(0);
});

test('M2 build: a #fp= descriptor still launches, with the user token and the legacy transport', async ({ page }) => {
  test.skip(!LEGACY, 'only in the M2 build: FP_LEGACY_BUILD=1 VITE_FP_LEGACY_DESCRIPTOR=1');
  await page.addInitScript(() => localStorage.setItem('token', 'e2e-token'));
  const posted: Array<{ method: string; headers: Record<string, string>; body: unknown }> = [];
  await page.route('**/api/dms/v1/master/form**', async (route) => {
    const request = route.request();
    posted.push({ method: request.method(), headers: request.headers(), body: request.postDataJSON() });
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: MASTER, name: 'Vendor', source: 'formplus', updated_at: 'T1' } }) });
  });
  await page.route('**/dms-return**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>DMS</title><p>back in DMS</p>' }));
  const descriptor = Buffer.from(JSON.stringify({ v: 1, mode: 'dms-master', profile: 'dms-v1', tenantId: 'acme', workspaceId: 'ws_1', master: { name: 'Vendor', doctypeIds: [], folderIds: [] }, returnUrl: RETURN, apiBase: 'http://localhost:4173/api' })).toString('base64url');
  await page.goto(`/embed/dms-master#fp=${descriptor}`);
  const palette = page.getByRole('complementary').first();
  await palette.getByRole('button', { name: 'Email' }).click();
  expect(page.url()).not.toContain('fp=');
  await page.getByRole('button', { name: 'Save to DMS' }).click();
  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0]!.headers['authorization']).toBe('Bearer e2e-token');
  expect(posted[0]!.headers['x-tenant-id']).toBe('acme');
});
