import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures, initPayload } from '../bridge/fixtures.ts';
import { parseMessage, type BridgeMessage } from '../bridge/protocol.ts';
import DmsUploadPage from './DmsUploadPage.tsx';

/* The page with a stand-in parent: the lookup picker is a searchable field only when the parent announced fp_caps=lookup (T-BR-L6), and the parent's rows fill the mapped fields. */

const ORIGIN = window.location.origin;
const A = (n: number) => `a2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const el = (n: number, name: string) => ({ id: A(n), type: 'textinput', value: name, name, label: name });
let parentWin: Window;
let posts: BridgeMessage[];

function frame() {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  parentWin = iframe.contentWindow as Window;
  posts = [];
  vi.spyOn(parentWin, 'postMessage').mockImplementation(((message: unknown) => {
    const parsed = parseMessage(message);
    if (parsed.ok) posts.push(parsed.message);
  }) as never);
  Object.defineProperty(window, 'parent', { configurable: true, value: parentWin });
}
const fromParent = (data: unknown) => act(() => void window.dispatchEvent(new MessageEvent('message', { data, origin: ORIGIN, source: parentWin })));
const of = (type: string) => posts.filter((m) => m.type === type);
const init = () => {
  const payload = initPayload();
  payload.doctypeFields = [];
  payload.values = {};
  payload.masterFields = [fixtures.lookup.pickerElement as never, el(2, 'City'), el(3, 'Phone'), el(4, 'Tax Id')];
  return { protocol: 'fp-bridge/1', type: 'init', id: 'p-init-1', payload };
};

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'parent');
  vi.restoreAllMocks();
});

describe('DmsUploadPage lookups', () => {
  describe('without fp_caps=lookup', () => {
    beforeEach(() => {
      window.history.replaceState({}, '', `/embed/dms-upload?fp_parent=${encodeURIComponent(ORIGIN)}&fp_v=1`);
      frame();
    });

    it('T-BR-L6: ready.capabilities is the handshake fixture, the picker is a plain input and typing sends no lookup.request', async () => {
      const user = userEvent.setup();
      render(<DmsUploadPage />);
      expect(of('ready')[0]!.payload).toEqual((fixtures.handshake[0] as Extract<BridgeMessage, { type: 'ready' }>).payload);
      fromParent(init());
      await user.type(await screen.findByRole('textbox', { name: /Vendor/ }), 'acme');
      expect(screen.queryByRole('combobox', { name: /Vendor/ })).not.toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 450));
      expect(of('lookup.request')).toHaveLength(0);
    });
  });

  describe('with fp_caps=lookup', () => {
    beforeEach(() => {
      window.history.replaceState({}, '', `/embed/dms-upload?fp_parent=${encodeURIComponent(ORIGIN)}&fp_v=1&fp_caps=lookup`);
      frame();
    });

    it('ready.capabilities does not change; typing asks the parent once the debounce has passed, and a picked row fills the mapped fields', async () => {
      const user = userEvent.setup();
      render(<DmsUploadPage />);
      expect(of('ready')[0]!.payload).toEqual((fixtures.handshake[0] as Extract<BridgeMessage, { type: 'ready' }>).payload);
      fromParent(init());
      await user.type(await screen.findByRole('combobox', { name: /Vendor/ }), 'acm');
      await waitFor(() => expect(of('lookup.request')).toHaveLength(1), { timeout: 3000 });
      expect(of('lookup.request')[0]!.payload).toEqual({ lookupId: 'vendor', search: 'acm' });
      const [request, result] = fixtures.lookup.exchange;
      fromParent({ ...result, replyTo: of('lookup.request')[0]!.id, payload: { ...result.payload, rows: [...result.payload.rows] } });
      void request;
      await user.click(await screen.findByRole('option', { name: /Acme Traders/ }));
      await waitFor(() => expect(screen.getByRole('textbox', { name: /City/ })).toHaveValue('Pune'));
      expect(screen.getByRole('textbox', { name: /Phone/ })).toHaveValue('9800000001');
      // The fill reaches DMS as an ordinary change of the mapped fields.
      await waitFor(() => {
        const last = of('change').at(-1)?.payload as { values: Record<string, string> } | undefined;
        expect(last?.values[A(2)]).toBe('Pune');
      }, { timeout: 3000 });
    });

    it('an answer from the wrong window or origin changes nothing (T-BR-L1)', async () => {
      const user = userEvent.setup();
      render(<DmsUploadPage />);
      fromParent(init());
      await user.type(await screen.findByRole('combobox', { name: /Vendor/ }), 'acm');
      await waitFor(() => expect(of('lookup.request')).toHaveLength(1), { timeout: 3000 });
      const [, result] = fixtures.lookup.exchange;
      const forged = { ...result, replyTo: of('lookup.request')[0]!.id };
      act(() => void window.dispatchEvent(new MessageEvent('message', { data: forged, origin: 'https://evil.example', source: parentWin })));
      act(() => void window.dispatchEvent(new MessageEvent('message', { data: forged, origin: ORIGIN, source: null })));
      await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
      expect(screen.queryByRole('option', { name: /Acme Traders/ })).not.toBeInTheDocument();
    });
  });
});
