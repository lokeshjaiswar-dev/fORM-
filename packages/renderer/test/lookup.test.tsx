// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeUrl } from '@form/schema';
import { FormRenderer, type RemoteSource } from '../src/index.ts';
import { field, form, page, props, runtime } from './build.ts';

/*
 * Server-side lookups in the renderer (T-LK-12): the picker is a searchable combobox fed by the host's RemoteSource, with
 * a 300 ms debounce, no call below minChars, the older query aborted by the newer, at most maxRows rows, and mapped fields
 * filled only from the cells the lookup declares. API options and checks come through the same source. With no source nothing
 * touches the network.
 */

const url = 'https://hr.example.com/people' as SafeUrl;
const lookup = (over: Record<string, unknown> = {}) => ({
  id: 'hr', name: 'HR', enabled: true, url, pickerFieldId: 'emp', pickerKey: 'name', minChars: 2, maxRows: 2,
  mappings: [{ key: 'city', fieldId: 'city_name' }, { key: 'age', fieldId: 'age' }, { key: 'secret', fieldId: 'secret_field' }, { key: 'nofield' }],
  ...over,
});
const definition = (over: Record<string, unknown> = {}) => {
  const def = form(
    [field('short_text', 'emp'), field('short_text', 'city_name'), field('number', 'age'), field('short_text', 'secret_field')],
    [page('p1', ['emp', 'city_name', 'age', 'secret_field'])],
  );
  def.lookups = [lookup(over)] as never;
  return def;
};
// The public projection holds only the lookup's declared keys; the renderer ignores any other cell.
const rows = [
  { label: 'Maya Rao', cells: { name: 'Maya Rao', city: 'Pune', age: '31', secret: 'not-declared-in-public', extra: 'x' } },
  { label: 'Maya Iyer', cells: { name: 'Maya Iyer', city: 'Goa', age: 'abc' } },
  { label: 'Maya Third', cells: { name: 'Maya Third' } },
];

function source(over: Partial<RemoteSource> = {}) {
  const lookupFn = vi.fn(async (_id: string, _q: string, _signal: AbortSignal) => ({ rows, truncated: false }));
  const remote: RemoteSource = { lookup: lookupFn, ...over };
  return { remote, lookupFn };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const picker = () => screen.getByRole('combobox');
const type = (text: string) => fireEvent.change(picker(), { target: { value: text } });
const settle = async (ms = 350) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('the lookup combobox', () => {
  it('waits 300 ms after the last keystroke, asks only from minChars, and shows at most maxRows rows', async () => {
    const { remote, lookupFn } = source();
    render(<FormRenderer {...props(runtime(definition()), { remote })} />);
    type('m');
    await settle();
    expect(lookupFn).not.toHaveBeenCalled();
    type('ma');
    await settle(200);
    type('may');
    await settle(200);
    expect(lookupFn).not.toHaveBeenCalled();
    await settle(150);
    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(lookupFn).toHaveBeenCalledWith('hr', 'may', expect.any(AbortSignal));
    expect(await screen.findAllByRole('option')).toHaveLength(2);
  });

  it('aborts the older query when a newer one starts, and ignores the older answer', async () => {
    const signals: AbortSignal[] = [];
    let first: (v: { rows: typeof rows; truncated: boolean }) => void = () => {};
    const lookupFn = vi.fn((_id: string, q: string, signal: AbortSignal) => {
      signals.push(signal);
      if (q === 'maya') return new Promise<{ rows: typeof rows; truncated: boolean }>((resolve) => { first = resolve; });
      return Promise.resolve({ rows: [rows[1]!], truncated: false });
    });
    render(<FormRenderer {...props(runtime(definition()), { remote: { lookup: lookupFn } })} />);
    type('maya');
    await settle();
    type('maya i');
    await settle();
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    await act(async () => first({ rows: [rows[0]!], truncated: false }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Maya Iyer']);
  });

  it('on a pick the answer is the label and the mapped fields are filled from the declared cells only', async () => {
    const { remote } = source();
    render(<FormRenderer {...props(runtime(definition()), { remote })} />);
    type('maya');
    await settle();
    fireEvent.mouseDown((await screen.findAllByRole('option'))[0]!);
    await waitFor(() => expect(picker()).toHaveValue('Maya Rao'));
    expect(screen.getByRole('textbox', { name: /city_name/ })).toHaveValue('Pune');
    expect(screen.getByRole('textbox', { name: /age/ })).toHaveValue('31');
    // `extra` has no mapping, so it is written nowhere; `secret` is a declared mapping here, so it fills its field.
    expect(screen.getByRole('textbox', { name: /secret_field/ })).toHaveValue('not-declared-in-public');
  });

  it('ignores cells for keys the lookup does not declare', async () => {
    const { remote } = source();
    render(<FormRenderer {...props(runtime(definition({ mappings: [{ key: 'city', fieldId: 'city_name' }] })), { remote })} />);
    type('maya');
    await settle();
    fireEvent.mouseDown((await screen.findAllByRole('option'))[0]!);
    await waitFor(() => expect(picker()).toHaveValue('Maya Rao'));
    expect(screen.getByRole('textbox', { name: /city_name/ })).toHaveValue('Pune');
    expect(screen.getByRole('textbox', { name: /secret_field/ })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /age/ })).toHaveValue('');
  });

  it('clears the mapped fields when the picker is emptied, and does not fill a number from text', async () => {
    const { remote } = source();
    render(<FormRenderer {...props(runtime(definition()), { remote })} />);
    type('maya');
    await settle();
    fireEvent.mouseDown((await screen.findAllByRole('option'))[1]!);
    await waitFor(() => expect(screen.getByRole('textbox', { name: /city_name/ })).toHaveValue('Goa'));
    expect(screen.getByRole('textbox', { name: /age/ })).toHaveValue('');
    type('');
    await waitFor(() => expect(screen.getByRole('textbox', { name: /city_name/ })).toHaveValue(''));
  });

  it('supports the keyboard: arrows move, Enter picks, Escape closes', async () => {
    const { remote } = source();
    render(<FormRenderer {...props(runtime(definition()), { remote })} />);
    type('maya');
    await settle();
    await screen.findAllByRole('option');
    fireEvent.keyDown(picker(), { key: 'ArrowDown' });
    fireEvent.keyDown(picker(), { key: 'ArrowDown' });
    fireEvent.keyDown(picker(), { key: 'Enter' });
    await waitFor(() => expect(picker()).toHaveValue('Maya Iyer'));
    type('maya');
    await settle();
    await screen.findAllByRole('option');
    fireEvent.keyDown(picker(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
  });

  it('shows a plain input, and touches no network, when the host passes no source (T-LK-12)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<FormRenderer {...props(runtime(definition()))} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: /^emp/ }), { target: { value: 'maya' } });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('API option lists and checks through the source', () => {
  it('loads a field\'s options with remote.options and falls back to the stored ones with no source', async () => {
    const def = form(
      [field('single_choice', 'size', { config: { display: 'dropdown', options: [{ id: 's' as never, label: 'Stored' }] }, apiOptions: { url, itemsPath: 'a' } })],
      [page('p1', ['size'])],
    );
    const options = vi.fn(async () => [{ id: 'm' as never, label: 'From the server' }]);
    const { unmount } = render(<FormRenderer {...props(runtime(def), { remote: { lookup: async () => ({ rows: [], truncated: false }), options } })} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'From the server' })).toBeInTheDocument());
    expect(options).toHaveBeenCalledWith('size', expect.any(AbortSignal));
    unmount();
    render(<FormRenderer {...props(runtime(def))} />);
    expect(screen.getByRole('option', { name: 'Stored' })).toBeInTheDocument();
  });
});
