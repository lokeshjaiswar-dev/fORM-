import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type FrameLocator, type Page } from '@playwright/test';

/*
 * Shared by the fp-bridge/2 e2e specs: the stand-in classic parent (dms-upload-parent.html), a 14-field form for the upload step
 * (the /1 contract fixture, which stays until M4: its fields and expected answers are the oracle, now answered in `collected`),
 * and the handshake of SEC-DESIGN 3.4 (hello on the window, one port back, everything else on the port).
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export const PARENT_PAGE = readFileSync(here('./dms-upload-parent.html'), 'utf8');

export interface V1Case {
  userInput: Record<string, string>;
  expectedValidated: { payload: { valid: boolean; errors: Array<{ fieldId: string; code: string }>; values: Record<string, string> } };
  expectedRecord?: Record<string, string>;
}
export const v1 = JSON.parse(readFileSync(here('../../src/embed/bridge/__fixtures__/fp-bridge-v1.fixtures.json'), 'utf8')) as {
  handshake: Array<{ payload: Record<string, unknown> }>;
  optionsExchange: Array<{ payload: Record<string, unknown> }>;
  cases: V1Case[];
};

export const DIALOG = 'dlg-e2e-1';
export const CATEGORY = 'a1000000-0000-4000-8000-000000000006';
export const REQ = 'e2e-req-0000000000001';

export type Msg = Record<string, any> & { type: string };

/** The 14-field form as an fp-bridge/2 `init` (nothing masked, no lookups); `over` replaces keys. */
export function initV2(over: Record<string, unknown> = {}): Msg {
  const p = v1.handshake[1]!.payload as { doctypeFields: unknown[]; masterFields: unknown[]; values: Record<string, string>; locale: string; readOnly: boolean; context: unknown };
  return { protocol: 'fp-bridge/2', type: 'init', dialogId: DIALOG, doctypeFields: p.doctypeFields, masterFields: p.masterFields, values: p.values, masked: [], lookups: [], locale: p.locale, readOnly: p.readOnly, context: p.context, ...over };
}

/** Opens the stand-in parent at this build's origin; the child it frames is at `childOrigin` (default: the same). */
export async function openParent(page: Page, opts: { childOrigin?: string; path?: string; manual?: boolean } = {}) {
  await page.route('**/fp-parent.html**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PARENT_PAGE }));
  const query = new URLSearchParams({ ...(opts.childOrigin ? { childOrigin: opts.childOrigin } : {}), ...(opts.path ? { path: opts.path } : {}), ...(opts.manual ? { manual: '1' } : {}) }).toString();
  await page.goto(`/fp-parent.html${query ? `?${query}` : ''}`);
}

export const log = (page: Page) => page.evaluate(() => (window as unknown as { fpLog: Msg[] }).fpLog);
export const windowLog = (page: Page) => page.evaluate(() => (window as unknown as { fpWindowLog: unknown[] }).fpWindowLog);
export const send = (page: Page, message: unknown) => page.evaluate((m) => (window as unknown as { fpSend: (m: unknown) => void }).fpSend(m), message);
export const portReady = (page: Page) => page.evaluate(() => (window as unknown as { fpPortReady: boolean }).fpPortReady);

export async function waitFor(page: Page, type: string, nth = 0): Promise<Msg> {
  await expect.poll(async () => (await log(page)).filter((m) => m.type === type).length, { message: `waiting for ${type}` }).toBeGreaterThan(nth);
  return (await log(page)).filter((m) => m.type === type)[nth]!;
}

export const form = (page: Page): FrameLocator => page.frameLocator('#child');

/** hello -> port -> init -> initialized; the master dropdown's options request is answered as the parent would. */
export async function handshake(page: Page, over: Record<string, unknown> = {}) {
  await expect.poll(() => portReady(page), { message: 'waiting for hello and the port handover' }).toBe(true);
  await send(page, initV2(over));
  const initialized = await waitFor(page, 'initialized');
  const request = await waitFor(page, 'options.request');
  await send(page, { protocol: 'fp-bridge/2', type: 'options.result', replyTo: request['id'], fieldId: request['fieldId'], ...v1.optionsExchange[1]!.payload });
  return { initialized, request };
}

/** The values of the valid case, typed through the real form in the frame. */
export async function typeValidCase(page: Page) {
  const f = form(page);
  const input = v1.cases[0]!.userInput;
  await f.getByRole('textbox', { name: /Invoice Amount/ }).fill(input['d1000000-0000-4000-8000-000000000002']!);
  await f.getByRole('textbox', { name: /Billing Email/ }).fill(input['d1000000-0000-4000-8000-000000000003']!);
  await f.getByRole('textbox', { name: /Billing Phone/ }).fill(input['d1000000-0000-4000-8000-000000000004']!);
  await f.getByRole('textbox', { name: /Remarks/ }).fill(input['d1000000-0000-4000-8000-000000000005']!);
  await f.getByRole('textbox', { name: /Vendor Code/ }).fill(input['a1000000-0000-4000-8000-000000000002']!);
  await f.getByRole('textbox', { name: /Vendor Phone/ }).fill(input['a1000000-0000-4000-8000-000000000004']!);
  await f.getByRole('textbox', { name: /Vendor Address/ }).fill(input['a1000000-0000-4000-8000-000000000005']!);
  const pick = async (name: RegExp, label: string) =>
    f.getByRole('combobox', { name }).selectOption({ label }).catch(async () => {
      await f.getByRole('combobox', { name }).click();
      await f.getByRole('option', { name: label }).click();
    });
  await pick(/Currency/, input['d1000000-0000-4000-8000-000000000006']!);
  await pick(/Vendor Category/, input['a1000000-0000-4000-8000-000000000006']!);
}
