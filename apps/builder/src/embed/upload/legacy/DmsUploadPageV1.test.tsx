import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures, initPayload } from '../../bridge/fixtures.ts';
import { parseMessage, type BridgeMessage } from '../../bridge/protocol.ts';
import DmsUploadPageV1 from './DmsUploadPageV1.tsx';

/*
 * The page with the real renderer in jsdom and a stand-in parent window: the handshake, typing, validate, and what the
 * page refuses. (The browser round trip through a real iframe is e2e/dms-upload.spec.ts.)
 */

const ORIGIN = window.location.origin;
let parentWin: Window;
let posts: BridgeMessage[];

function frame() {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  parentWin = iframe.contentWindow as Window;
  posts = [];
  vi.spyOn(parentWin, 'postMessage').mockImplementation(((message: unknown, target: unknown) => {
    expect(target).toBe(ORIGIN);
    const parsed = parseMessage(message);
    expect(parsed.ok, JSON.stringify(message).slice(0, 200)).toBe(true);
    if (parsed.ok) posts.push(parsed.message);
  }) as never);
  Object.defineProperty(window, 'parent', { configurable: true, value: parentWin });
}

const fromParent = (data: unknown, over: { origin?: string; source?: Window | null } = {}) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: over.origin ?? ORIGIN, source: 'source' in over ? over.source : parentWin }));
  });
const of = (type: string) => posts.filter((m) => m.type === type);

beforeEach(() => {
  // fp-bridge/1 allowlist: the retired reader no longer defaults to its own origin (an empty list denies), so the legacy build lists the parent.
  vi.stubEnv('VITE_FP_EMBED_PARENTS', ORIGIN);
  window.history.replaceState({}, '', `/embed/dms-upload?fp_parent=${encodeURIComponent(ORIGIN)}&fp_v=1`);
  frame();
});
afterEach(() => {
  vi.unstubAllEnvs();
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'parent');
  vi.restoreAllMocks();
});

describe('DmsUploadPageV1', () => {
  it('says ready to the allowlisted parent and shows the fixture form in two titled sections', async () => {
    render(<DmsUploadPageV1 />);
    expect(of('ready')[0]!.payload).toEqual({ version: '1', capabilities: ['options', 'readOnly'] });
    fromParent(fixtures.handshake[1]);
    expect(await screen.findByRole('heading', { name: 'Document details' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Master details' })).toBeInTheDocument();
    // The class that scopes upload-panel.css (the classic panel look) is on this page's root as on the /2 page's.
    expect(screen.getByRole('heading', { name: 'Document details' }).closest('[data-testid=upload-root]')).toHaveClass('fp-upload');
    expect(of('initialized')[0]).toMatchObject({ replyTo: 'p-init-1', payload: { fieldCount: 14, unsupported: [] } });
    const doc = within(screen.getByRole('heading', { name: 'Document details' }).closest('section')!);
    expect(doc.getByRole('textbox', { name: /Invoice No/ })).toHaveValue('INV-0007');
    expect(doc.getByRole('textbox', { name: /Invoice No/ })).toHaveAttribute('readonly');
    // The master dropdown has no options of its own: the child asks the parent.
    expect(of('options.request')[0]!.payload).toMatchObject({ fieldId: 'a1000000-0000-4000-8000-000000000006', page: 1 });
  });

  it('typing reports change; validate answers in the contract shape with the field errors shown', async () => {
    const user = userEvent.setup();
    render(<DmsUploadPageV1 />);
    fromParent(fixtures.handshake[1]);
    const name = await screen.findByRole('textbox', { name: /Vendor Name/ });
    await user.clear(name);
    await user.type(name, 'Acme 2');
    // `change` is debounced: under load an earlier one (an intermediate keystroke) can exist first, so wait for the last one to carry the typed text.
    const lastChange = () => of('change').at(-1)?.payload as { values: Record<string, string>; valid: boolean } | undefined;
    await waitFor(() => expect(lastChange()?.values['a1000000-0000-4000-8000-000000000001']).toBe('Acme 2'), { timeout: 3000 });
    const change = lastChange()!;
    expect(change.valid).toBe(false);

    fromParent(fixtures.cases[0]!.validate);
    await waitFor(() => expect(of('validated')).toHaveLength(1));
    const validated = of('validated')[0] as Extract<BridgeMessage, { type: 'validated' }>;
    expect(validated.replyTo).toBe('p-val-1');
    expect(validated.payload.valid).toBe(false);
    expect(validated.payload.errors.map((e) => `${e.fieldId}:${e.code}`)).toContain('a1000000-0000-4000-8000-000000000001:pattern');
    expect(validated.payload.values['a1000000-0000-4000-8000-000000000001']).toBe('Acme 2');
    // The renderer shows its own inline errors too.
    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThan(0);
  });

  it('a message from another origin or window is ignored: no form, no answer', async () => {
    render(<DmsUploadPageV1 />);
    fromParent(fixtures.handshake[1], { origin: 'https://evil.example' });
    fromParent(fixtures.handshake[1], { source: null });
    await act(async () => void (await Promise.resolve()));
    expect(screen.queryByRole('heading', { name: 'Document details' })).not.toBeInTheDocument();
    expect(of('initialized')).toHaveLength(0);
  });

  it('a re-sent init replaces the form and keeps one listener (one answer per init)', async () => {
    render(<DmsUploadPageV1 />);
    fromParent(fixtures.handshake[1]);
    await screen.findByRole('heading', { name: 'Document details' });
    fromParent({ ...fixtures.handshake[1], id: 'p-init-2' });
    await waitFor(() => expect(of('initialized')).toHaveLength(2));
    expect(of('initialized').map((m) => m.replyTo)).toEqual(['p-init-1', 'p-init-2']);
    expect(screen.getAllByRole('heading', { name: 'Document details' })).toHaveLength(1);
  });

  it('an init with an unsupported type answers with the ids and shows no form', async () => {
    render(<DmsUploadPageV1 />);
    fromParent(fixtures.unsupported.init);
    await waitFor(() => expect(of('initialized')).toHaveLength(1));
    expect(of('initialized')[0]!.payload).toEqual({ fieldCount: 1, unsupported: ['d2000000-0000-4000-8000-000000000001'] });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('removes its listener on unmount', async () => {
    const { unmount } = render(<DmsUploadPageV1 />);
    unmount();
    fromParent(fixtures.handshake[1]);
    expect(of('initialized')).toHaveLength(0);
  });
});

describe('DmsUploadPageV1 refusals', () => {
  it('a parent that is not on the allowlist: a notice, and nothing is sent', () => {
    window.history.replaceState({}, '', `/embed/dms-upload?fp_parent=${encodeURIComponent('https://evil.example')}&fp_v=1`);
    render(<DmsUploadPageV1 />);
    expect(screen.getByTestId('upload-notice')).toHaveAttribute('data-problem', 'not_allowed');
    expect(posts).toEqual([]);
    fromParent(fixtures.handshake[1], { origin: 'https://evil.example' });
    expect(posts).toEqual([]);
  });

  it('no fp_parent, or an unreadable one: a notice, nothing sent', () => {
    for (const [query, problem] of [['', 'missing'], ['?fp_parent=nope', 'malformed']] as const) {
      window.history.replaceState({}, '', `/embed/dms-upload${query}`);
      const { unmount } = render(<DmsUploadPageV1 />);
      expect(screen.getByTestId('upload-notice')).toHaveAttribute('data-problem', problem);
      unmount();
    }
    expect(posts).toEqual([]);
  });

  it('not framed (window.parent is the window itself): a notice', () => {
    Object.defineProperty(window, 'parent', { configurable: true, value: window });
    render(<DmsUploadPageV1 />);
    expect(screen.getByTestId('upload-notice')).toHaveAttribute('data-problem', 'not_framed');
  });

  it('a protocol version other than 1 in the query: a fatal unsupported_version to the parent, no handshake', () => {
    window.history.replaceState({}, '', `/embed/dms-upload?fp_parent=${encodeURIComponent(ORIGIN)}&fp_v=2`);
    render(<DmsUploadPageV1 />);
    expect(posts.map((m) => m.type)).toEqual(['error']);
    expect(posts[0]!.payload).toMatchObject({ code: 'unsupported_version', fatal: true });
    expect(screen.getByTestId('upload-notice')).toHaveAttribute('data-problem', 'version');
    fromParent(fixtures.handshake[1]);
    expect(of('initialized')).toHaveLength(0);
  });

  it('the page reads init values keyed by field id only: an init value for an unknown id changes nothing', async () => {
    render(<DmsUploadPageV1 />);
    const init = initPayload();
    init.values = { ...init.values, 'ffffffff-0000-4000-8000-000000000000': 'ghost' };
    fromParent({ ...fixtures.handshake[1], payload: init });
    await screen.findByRole('heading', { name: 'Master details' });
    fromParent(fixtures.cases[0]!.validate);
    await waitFor(() => expect(of('validated')).toHaveLength(1));
    expect(JSON.stringify(of('validated')[0]!.payload)).not.toContain('ghost');
  });
});
