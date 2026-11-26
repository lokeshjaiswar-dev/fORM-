import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { caseInput, v2Init } from './v2Harness.ts';
import DmsUploadPage from './DmsUploadPage.tsx';
import UploadApp from './UploadApp.tsx';

/*
 * The /2 page with the real renderer in jsdom, a stand-in parent window and a real MessageChannel: hello, the port handover,
 * init, typing (state, never values), collect -> collected, and what the page refuses. (The browser round trip through a real
 * sandboxed iframe is e2e/dms-upload.sandbox.spec.ts.)
 */

const ORIGIN = window.location.origin;
let parentWin: Window;
let hellos: Array<[unknown, unknown]>;
let channels: MessageChannel[];

beforeEach(() => {
  vi.stubEnv('VITE_FP_EMBED_PARENTS', ORIGIN);
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  parentWin = iframe.contentWindow as Window;
  hellos = [];
  channels = [];
  vi.spyOn(parentWin, 'postMessage').mockImplementation(((message: unknown, target: unknown) => void hellos.push([message, target])) as never);
  Object.defineProperty(window, 'parent', { configurable: true, value: parentWin });
});
afterEach(() => {
  for (const c of channels) {
    c.port1.close();
    c.port2.close();
  }
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'parent');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The parent's side: a channel whose port2 goes to the child in a `port` message from `over.source` / `over.origin`. */
function handover(over: { source?: Window | null; origin?: string; dialogId?: string; data?: unknown; ports?: unknown[] } = {}) {
  const channel = new MessageChannel();
  channels.push(channel);
  const received: Array<Record<string, any>> = [];
  channel.port1.onmessage = (e) => void received.push(e.data as Record<string, any>);
  const event = Object.assign(new Event('message'), {
    source: 'source' in over ? over.source : parentWin,
    origin: over.origin ?? ORIGIN,
    data: over.data ?? { protocol: 'fp-bridge/2', type: 'port', dialogId: over.dialogId ?? 'dlg-1' },
    ports: over.ports ?? [channel.port2],
  });
  act(() => void window.dispatchEvent(event));
  const of = (type: string) => received.filter((m) => m.type === type);
  return { channel, received, of, post: (message: unknown) => channel.port1.postMessage(message) };
}

describe('UploadApp', () => {
  it('says an empty hello to the parent window (target "*") and shows nothing until the port arrives', () => {
    const { container } = render(<UploadApp />);
    expect(hellos).toEqual([[{ protocol: 'fp-bridge/2', type: 'hello' }, '*']]);
    expect(container.querySelector('[data-testid=upload-root]')).toBeEmptyDOMElement();
  });

  it('after the handover and an init on the port: the form in two titled sections, initialized back on the port', async () => {
    render(<UploadApp />);
    const parent = handover();
    parent.post(v2Init());
    expect(await screen.findByRole('heading', { name: 'Document details' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Master details' })).toBeInTheDocument();
    await waitFor(() => expect(parent.of('initialized')).toHaveLength(1));
    expect(parent.of('initialized')[0]).toEqual({ protocol: 'fp-bridge/2', type: 'initialized', dialogId: 'dlg-1', fieldCount: 9, unsupported: [] });
    expect(screen.getByRole('textbox', { name: /Invoice No/ })).toHaveValue('INV-0007');
    expect(screen.getByRole('textbox', { name: /Invoice No/ })).toHaveAttribute('readonly');
    // The masked secret is empty and says so: its stored value is not in this page.
    expect(screen.getByRole('textbox', { name: /Tax Id/ })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /Tax Id/ })).toHaveAttribute('placeholder', 'Stored (hidden)');
  });

  it('typing reports state, never the text; collect answers with the values, once', async () => {
    const user = userEvent.setup();
    render(<UploadApp />);
    const parent = handover();
    parent.post(v2Init());
    const name = await screen.findByRole('textbox', { name: /Vendor Name/ });
    await user.clear(name);
    await user.type(name, 'Zebra Ltd');
    await waitFor(() => expect(parent.of('state').at(-1)).toMatchObject({ valid: true, dirty: true, touched: ['c2000000-0000-4000-8000-000000000101'] }), { timeout: 3000 });
    expect(JSON.stringify(parent.received)).not.toContain('Zebra');

    const req = 'r4nd0m-req-0000000001';
    parent.post({ protocol: 'fp-bridge/2', type: 'collect', dialogId: 'dlg-1', req });
    parent.post({ protocol: 'fp-bridge/2', type: 'collect', dialogId: 'dlg-1', req });
    await waitFor(() => expect(parent.of('collected')).toHaveLength(1));
    await act(async () => void (await new Promise((r) => setTimeout(r, 100))));
    expect(parent.of('collected')).toHaveLength(1);
    const collected = parent.of('collected')[0]!;
    expect(collected).toMatchObject({ dialogId: 'dlg-1', req, valid: true, errors: [] });
    expect(collected['values']['c2000000-0000-4000-8000-000000000101']).toBe('Zebra Ltd');
    expect(collected['values']).not.toHaveProperty('c2000000-0000-4000-8000-000000000102'); // the untouched secret
    expect(JSON.stringify(parent.received.filter((m) => m['type'] !== 'collected'))).not.toContain('Zebra');
  });

  it('a port from another window, from an origin that is not listed, or without a dialog id gives no form and no answer', async () => {
    render(<UploadApp />);
    const rogue = handover({ source: null });
    const evil = handover({ origin: 'https://evil.example' });
    const sibling = handover({ source: window });
    const junk = handover({ data: { protocol: 'fp-bridge/2', type: 'port' } });
    for (const p of [rogue, evil, sibling, junk]) p.post(v2Init());
    await act(async () => void (await new Promise((r) => setTimeout(r, 150))));
    expect(screen.queryByRole('heading', { name: 'Document details' })).not.toBeInTheDocument();
    for (const p of [rogue, evil, sibling, junk]) expect(p.received).toEqual([]);
    // The page is still waiting: the real parent's handover works.
    const parent = handover();
    parent.post(v2Init());
    expect(await screen.findByRole('heading', { name: 'Document details' })).toBeInTheDocument();
  });

  it('takes one port only: a second handover is ignored and cannot talk to the form', async () => {
    render(<UploadApp />);
    const first = handover();
    first.post(v2Init());
    await screen.findByRole('heading', { name: 'Document details' });
    const second = handover({ dialogId: 'dlg-2' });
    second.post({ ...v2Init(), dialogId: 'dlg-2' });
    await act(async () => void (await new Promise((r) => setTimeout(r, 150))));
    expect(second.received).toEqual([]);
  });

  it('an init for another dialog than the port\'s is dropped', async () => {
    render(<UploadApp />);
    const parent = handover({ dialogId: 'dlg-1' });
    parent.post({ ...v2Init(), dialogId: 'dlg-9' });
    await act(async () => void (await new Promise((r) => setTimeout(r, 150))));
    expect(parent.received).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'Document details' })).not.toBeInTheDocument();
  });

  it('an init with an unsupported type: initialized names the ids and no form is shown', async () => {
    render(<UploadApp />);
    const parent = handover();
    parent.post({ ...(caseInput('init-create-empty') as object), doctypeFields: [{ id: 'd2000000-0000-4000-8000-000000000001', type: 'checkboxes', label: '', value: 'Flags', required: false }] });
    await waitFor(() => expect(parent.of('initialized')).toHaveLength(1));
    expect(parent.of('initialized')[0]).toMatchObject({ fieldCount: 1, unsupported: ['d2000000-0000-4000-8000-000000000001'] });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('opened with no allowed parent (VITE_FP_EMBED_PARENTS empty): a notice, no hello, and a handover is not taken', async () => {
    vi.stubEnv('VITE_FP_EMBED_PARENTS', '');
    render(<UploadApp />);
    expect(screen.getByTestId('upload-notice')).toHaveAttribute('data-problem', 'not_allowed');
    expect(hellos).toEqual([]);
    const parent = handover();
    parent.post(v2Init());
    await act(async () => void (await new Promise((r) => setTimeout(r, 100))));
    expect(parent.received).toEqual([]);
  });

  it('opened on its own (not framed): says to open it from DMS, and says nothing to anybody', () => {
    Object.defineProperty(window, 'parent', { configurable: true, value: window });
    render(<UploadApp />);
    expect(screen.getByTestId('upload-notice')).toHaveAttribute('data-problem', 'not_framed');
    expect(hellos).toEqual([]);
  });

  it('removes its listener and closes the port on unmount', async () => {
    const { unmount } = render(<UploadApp />);
    unmount();
    const parent = handover();
    parent.post(v2Init());
    await act(async () => void (await new Promise((r) => setTimeout(r, 100))));
    expect(parent.received).toEqual([]);
  });
});

describe('DmsUploadPage (the switch)', () => {
  it('a default build speaks /2 only: fp_v=1 in the query changes nothing', () => {
    window.history.replaceState({}, '', '/embed/dms-upload?fp_v=1&fp_parent=https%3A%2F%2Fdms.example');
    render(<DmsUploadPage />);
    expect(hellos).toEqual([[{ protocol: 'fp-bridge/2', type: 'hello' }, '*']]);
  });
});
