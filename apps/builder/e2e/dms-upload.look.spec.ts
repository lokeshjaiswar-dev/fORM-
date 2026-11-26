import { expect, test, type Frame, type Page } from '@playwright/test';
import { DIALOG, REQ, form, handshake, initV2, log, openParent, send, v1 } from './fixtures/bridge-v2.ts';

/*
 * The look of the upload step's frame inside classic's "Doc Properties" panel (src/embed/upload/upload-panel.css): it reads as part of
 * the panel, not as a page of its own. Computed styles in the real browser, against the production build and its headers (the sandboxed
 * opaque-origin frame, fp-bridge/2). In the M2 legacy build (FP_LEGACY_BUILD=1 VITE_FP_LEGACY_DESCRIPTOR=1, `-g "both bridges"`) the same form
 * is also loaded through the retired fp-bridge/1 page and must look exactly like the fp-bridge/2 one.
 */

const LEGACY = process.env['FP_LEGACY_BUILD'] === '1';
const CLEAR = 'rgba(0, 0, 0, 0)';

/** What the frame looks like, as plain values (runs inside the frame). */
function look() {
  const cs = (e: Element) => getComputedStyle(e);
  const one = (s: string) => document.querySelector<HTMLElement>(s)!;
  const all = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
  const edges = (e: Element) => ['Top', 'Right', 'Bottom', 'Left'].map((side) => cs(e).getPropertyValue(`border-${side.toLowerCase()}-width`)).join(' ');
  const root = one('.fr-root');
  const formEl = one('.fr-form');
  const first = one('input.fr-input[readonly]');
  const textual = all('input.fr-input:not([readonly]), select.fr-input');
  return {
    paint: [document.documentElement, document.body, root, formEl].map((e) => cs(e).backgroundColor),
    paintImage: cs(root).backgroundImage,
    form: { padding: cs(formEl).padding, margin: cs(formEl).margin, shadow: cs(formEl).boxShadow, radius: cs(formEl).borderRadius, border: edges(formEl), left: Math.round(formEl.getBoundingClientRect().left) },
    root: { font: cs(root).fontFamily.split(',')[0], size: cs(root).fontSize, minHeight: cs(root).minHeight },
    sections: all('.fr-section').map((s, i) => ({ border: edges(s), radius: cs(s).borderRadius, padding: cs(s).padding, top: i === 0 ? '' : cs(s).borderTopColor })),
    heading: { size: cs(one('.fr-section-title')).fontSize, weight: cs(one('.fr-section-title')).fontWeight, color: cs(one('.fr-section-title')).color },
    label: { size: cs(one('.fr-label')).fontSize, weight: cs(one('.fr-label')).fontWeight, color: cs(one('.fr-label')).color, below: cs(one('.fr-label')).marginBottom },
    heights: all('input.fr-input, select.fr-input').map((e) => Math.round(e.getBoundingClientRect().height)),
    control: { border: cs(first).borderTopColor, radius: cs(first).borderRadius, size: cs(first).fontSize, color: cs(first).color },
    gap: Math.round(all('.fr-field')[1]!.getBoundingClientRect().top - all('.fr-field')[0]!.getBoundingClientRect().bottom),
    placeholder: cs(textual.find((e) => e.tagName === 'SELECT')!).color,
  };
}
type Look = ReturnType<typeof look>;

/** The document's size against the viewport's: a scrollbar, or a tail below the form, shows here (runs inside the frame). */
function fit() {
  const doc = document.documentElement;
  return { height: doc.scrollHeight, client: doc.clientHeight, bar: window.innerWidth - doc.clientWidth, form: Math.ceil(document.querySelector('.fr-root')!.getBoundingClientRect().height) };
}

const child = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.parentFrame() !== null);
  if (!frame) throw new Error('the child frame is not there');
  return frame;
};

/** The iframe is as tall as the form's document: nothing cut off, no empty tail, no scrollbar. */
async function expectFitted(page: Page) {
  await expect.poll(async () => {
    const [iframe, doc] = [await page.locator('#child').evaluate((e) => Math.round(e.getBoundingClientRect().height)), await child(page).evaluate(() => document.documentElement.scrollHeight)];
    return Math.abs(iframe - doc) <= 1;
  }, { message: 'the iframe height follows the form' }).toBe(true);
  const size = await child(page).evaluate(fit);
  expect(size.bar).toBe(0);
  expect(size.height).toBeLessThanOrEqual(size.client + 1);
  expect(size.height).toBeLessThanOrEqual(size.form + 1);
}

function expectClassicLook(l: Look) {
  // No page band, no card, no shadow, no margin: the parent's panel shows through and supplies the padding.
  expect(l.paint).toEqual([CLEAR, CLEAR, CLEAR, CLEAR]);
  expect(l.paintImage).toBe('none');
  expect(l.form).toMatchObject({ padding: '0px', margin: '0px', shadow: 'none', radius: '0px', border: '0px 0px 0px 0px', left: 0 });
  expect(l.root.minHeight).toBe('0px');
  // Classic's own font, size and weights (12.6px Noto Sans; label 400 #666 with 8px under it; a light heading).
  expect(l.root).toMatchObject({ font: '"Noto Sans Variable"', size: '12.6px' });
  expect(l.label).toEqual({ size: '12.6px', weight: '400', color: 'rgb(102, 102, 102)', below: '8px' });
  expect(l.heading).toEqual({ size: '13px', weight: '600', color: 'rgb(77, 77, 77)' });
  // Sections are headings with one divider between them, not bordered boxes.
  expect(l.sections.map((s) => s.border)).toEqual(['0px 0px 0px 0px', '1px 0px 0px 0px']);
  expect(l.sections.map((s) => s.radius)).toEqual(['0px', '0px']);
  expect(l.sections[1]!.top).toBe('rgb(229, 231, 235)');
  // Controls: 40px, radius 8px, the 1px rgba(0,0,0,.23) border, black text, 16px between fields.
  expect(new Set(l.heights)).toEqual(new Set([40]));
  expect(l.control).toEqual({ border: 'rgba(0, 0, 0, 0.23)', radius: '8px', size: '12.6px', color: 'rgb(0, 0, 0)' });
  expect(l.gap).toBe(16);
  expect(l.placeholder).toBe('rgb(118, 118, 118)');
}

/** Focus is a 2px accent line inside the field (never outside the frame's edge); an invalid field keeps the error colour. */
async function expectFocusAndErrors(page: Page, collect: () => Promise<void>) {
  const f = form(page);
  const amount = f.getByRole('textbox', { name: /Invoice Amount/ });
  await amount.focus();
  // The border and shadow ease in over 100 ms: the assertions retry until they have.
  await expect(amount).toHaveCSS('border-top-color', 'rgb(41, 80, 218)');
  await expect(amount).toHaveCSS('box-shadow', 'rgb(41, 80, 218) 0px 0px 0px 1px inset');
  await expect(amount).toHaveCSS('outline-offset', '-2px');
  const box = await amount.evaluate((e) => e.getBoundingClientRect().left);
  expect(box).toBeGreaterThanOrEqual(0);

  await f.getByRole('textbox', { name: /Vendor Email/ }).fill('');
  await collect();
  const error = f.getByText('This field is required.').first();
  await expect(error).toBeVisible();
  expect(await error.evaluate((e) => ({ size: getComputedStyle(e).fontSize, color: getComputedStyle(e).color }))).toEqual({ size: '12px', color: 'rgb(196, 48, 43)' });
  await expectFitted(page);
}

test.describe('the frame inside a classic-like panel (fp-bridge/2, sandboxed)', () => {
  test('transparent, no card or section boxes, classic-sized controls, fitted to the form, focus and errors inside the box', async ({ page }) => {
    await openParent(page);
    await handshake(page);
    await expect(form(page).getByRole('heading', { name: 'Master details' })).toBeVisible();
    await expectFitted(page);
    expectClassicLook(await child(page).evaluate(look));
    await expectFocusAndErrors(page, async () => {
      await send(page, { protocol: 'fp-bridge/2', type: 'collect', dialogId: DIALOG, req: REQ });
      await expect.poll(async () => (await log(page)).filter((m) => m.type === 'collected').length).toBe(1);
    });
  });

  test('a shorter form shrinks the frame again (no empty tail left by the viewport-sized root)', async ({ page }) => {
    await openParent(page);
    await handshake(page);
    await expectFitted(page);
    const tall = await page.locator('#child').evaluate((e) => e.getBoundingClientRect().height);
    const p = v1.handshake[1]!.payload as { doctypeFields: unknown[] };
    await send(page, initV2({ doctypeFields: p.doctypeFields.slice(0, 2), masterFields: [], values: {} }));
    await expect.poll(() => page.locator('#child').evaluate((e) => e.getBoundingClientRect().height)).toBeLessThan(tall / 3);
    await expectFitted(page);
  });
});

/** The retired same-origin parent (fp-bridge/1, `?fp_parent=`), as classic's FormPlusHost framed it before the sandbox. */
const PARENT_V1 = `<!doctype html><meta charset="utf-8"><title>fp-bridge/1 parent (look harness)</title>
<body style="margin:0"><iframe id="child" title="form" style="width:100%;border:0;height:40px"></iframe>
<script>
  const child = document.getElementById('child');
  window.fpLog = [];
  child.src = '/embed/dms-upload?fp_parent=' + encodeURIComponent(location.origin) + '&fp_v=1&fp_caps=lookup';
  addEventListener('message', (e) => {
    if (e.source !== child.contentWindow || e.origin !== location.origin || !e.data) return;
    window.fpLog.push(e.data);
    if (e.data.type === 'resize') child.style.height = e.data.payload.height + 'px';
  });
  window.fpSend = (m) => child.contentWindow.postMessage(m, location.origin);
</script>`;

test.describe('both bridges look the same (M2 legacy build only)', () => {
  test.skip(!LEGACY, 'only in the M2 build: FP_LEGACY_BUILD=1 VITE_FP_LEGACY_DESCRIPTOR=1');

  test('fp-bridge/1 page: the same look as fp-bridge/2, fitted, focus and errors inside the box', async ({ page, browser }) => {
    // fp-bridge/2 first, in its own page, for the reference values.
    const two = await browser.newPage();
    await openParent(two);
    await handshake(two);
    await expect(form(two).getByRole('heading', { name: 'Master details' })).toBeVisible();
    await expectFitted(two);
    const reference = await child(two).evaluate(look);
    await two.close();

    await page.route('**/fp-parent-v1.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PARENT_V1 }));
    await page.goto('/fp-parent-v1.html');
    const fromChild = (type: string) => page.evaluate((t) => (window as unknown as { fpLog: Array<{ type: string; id: string }> }).fpLog.filter((m) => m.type === t), type);
    const out = (m: unknown) => page.evaluate((x) => (window as unknown as { fpSend: (m: unknown) => void }).fpSend(x), m);
    await expect.poll(async () => (await fromChild('ready')).length).toBe(1);
    await out(v1.handshake[1]);
    await expect.poll(async () => (await fromChild('options.request')).length).toBeGreaterThan(0);
    const request = (await fromChild('options.request'))[0]!;
    await out({ ...v1.optionsExchange[1], replyTo: request.id });
    await expect(form(page).getByRole('heading', { name: 'Master details' })).toBeVisible();
    await expectFitted(page);

    const seen = await child(page).evaluate(look);
    expectClassicLook(seen);
    expect(seen).toEqual(reference);
    await expectFocusAndErrors(page, async () => {
      await out({ protocol: 'fp-bridge/1', type: 'validate', id: 'p-val-look', payload: {} });
      await expect.poll(async () => (await fromChild('validated')).length).toBe(1);
    });
  });
});
