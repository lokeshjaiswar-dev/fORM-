import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import masterFixtures from '@/embed/master/__fixtures__/dms-master-form.fixtures.json' with { type: 'json' };
import { installTestSession, resetTestSession } from '@/embed/session/testing';
import fixtures from './__fixtures__/dms-record.fixtures.json' with { type: 'json' };
import { SECRET_MASK } from './contract';
import { DmsRecordPage } from './DmsRecordPage';

/*
 * T-DMSINT-60, record part (SEC-DESIGN 5.3, 10.3 row 60): a record with a secret and a `__masked` cell. The secret is never prefilled and
 * never shown (the page says "Stored (hidden)" and offers "Replace"), an untouched secret is absent from the PATCH, and the mask string is
 * never sent. The cells and the bodies are the additive cases of the contract fixtures (dms-record.fixtures.json `v2Cases`).
 */

const API = fixtures.descriptor.add.apiBase;
const RETURN = 'https://dms.example.test/dms/tenant-1/documents/master';
const VM = 'a1000000-0000-4000-8000-0000000000b1';
const VR = 'd3000000-0000-4000-8000-0000000000b1';
const READY = { timeout: 15_000 };

type Case = { name: string; request: { body?: unknown }; response: { status: number; body: Record<string, unknown> } };
const recordCase = (name: string) => (fixtures.v2Cases.cases as unknown as Case[]).find((c) => c.name === name)!;
const masterCase = (name: string) => (masterFixtures.v2Cases.cases as unknown as Case[]).find((c) => c.name === name)!;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/**
 * The fixture master as DMS answers it, with its text fields allowing digits and special characters: a text input without those two flags only
 * takes letters (the classic rule), and a secret such as a tax id needs digits. Test data only: the element and every rule are the app's own.
 */
function permissive(body: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(body) as { data: { form_builder_fields: Array<Record<string, unknown>> } };
  for (const f of copy.data.form_builder_fields) if (f.type === 'textinput') Object.assign(f, { numeric: true, specialChars: true });
  return copy;
}
const legacyOf = (path: string): string => {
  const rest = path.replace('/dms/v1/formplus/s/', '');
  return rest.startsWith('master/form') ? `/dms/v1/${rest}` : `/dms/${rest}`;
};

interface Call { method: string; path: string; body: unknown }

/** DMS as `owner` (can reveal hidden fields) or `editor` (cannot), answering the fixture's master and record. */
function dms(as: 'owner' | 'editor', over: { record?: unknown; patch?: Response } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = legacyOf(String(input).slice(API.length));
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET' && path === `/dms/v1/master/form/${VM}`) return json(200, permissive(masterCase(as === 'owner' ? 'show-as-revealer' : 'show-as-non-revealer').response.body));
      if (method === 'GET' && path === `/dms/master-records/${VR}?master_id=${VM}`) return json(200, over.record ?? recordCase(as === 'owner' ? 'load-masked-for-revealer' : 'load-masked-for-non-revealer').response.body);
      if (method === 'PATCH') return over.patch ?? json(200, recordCase('update-partial-without-the-untouched-secret').response.body);
      if (method === 'POST') return json(201, { success: true, data: { id: VR } });
      return json(404, {});
    }),
  );
  return calls;
}

function open(kind: 'add' | 'edit', as: 'owner' | 'editor', navigate = vi.fn()) {
  installTestSession({
    apiBase: API,
    context: { mode: 'dms-record', master_id: VM, record_id: kind === 'edit' ? VR : null, master_seed: null, return_url: RETURN, can: { reveal_fields: as === 'owner' } },
  });
  render(<DmsRecordPage navigate={navigate} />);
  return navigate;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const bodyOf = (calls: Call[]) => (writes(calls)[0]!.body as { master_id: string; master_record_id?: string; json_data: Record<string, string> });
const texts = () => document.body.textContent ?? '';
/** The input of a field (not the Replace button, whose aria-label names the field too). */
const field = (name: RegExp) => screen.findByLabelText(name, { selector: 'input,textarea,select' }, READY);

afterEach(() => {
  vi.unstubAllGlobals();
  resetTestSession();
});

describe('T-DMSINT-60: a secret on the record page', () => {
  it('is never prefilled and never shown: "Stored (hidden)" and a Replace button stand in for the field, and the mask is nowhere on the page', async () => {
    dms('editor');
    open('edit', 'editor');
    await field(/Vendor Name/);
    const row = screen.getByTestId('fp-secret-Tax Id');
    expect(within(row).getByText('Stored (hidden)')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Replace Tax Id' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Tax Id/, { selector: 'input,textarea,select' })).toBeNull();
    expect(texts()).not.toContain(SECRET_MASK);
    for (const input of Array.from(document.querySelectorAll('input,textarea'))) expect((input as HTMLInputElement).value).not.toBe(SECRET_MASK);
  });

  it('a hidden field is not on the page for a reader who cannot reveal it, and a revealer sees it with its value', async () => {
    dms('editor');
    const a = open('edit', 'editor');
    await field(/Vendor Name/);
    expect(screen.queryByLabelText(/Internal Note/)).toBeNull();
    expect(texts()).not.toContain('call back after the audit');
    expect(a).toBeDefined();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    resetTestSession();
    dms('owner');
    open('edit', 'owner');
    expect(await field(/Internal Note/)).toHaveValue('call back after the audit');
    // The revealer's secret is still masked: plaintext only comes through DMS's audited reveal.
    expect(within(screen.getByTestId('fp-secret-Tax Id')).getByText('Stored (hidden)')).toBeInTheDocument();
    expect(texts()).not.toContain(SECRET_MASK);
  });

  it('editing another field PATCHes exactly the fixture body: the untouched secret is absent and the mask is not sent', async () => {
    const calls = dms('owner');
    const navigate = open('edit', 'owner');
    const code = await field(/Vendor Code/);
    const user = userEvent.setup();
    await user.clear(code);
    await user.type(code, '1043');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]!.body).toEqual(recordCase('update-partial-without-the-untouched-secret').request.body);
    expect(JSON.stringify(writes(calls))).not.toContain('Tax Id');
    expect(JSON.stringify(writes(calls))).not.toContain(SECRET_MASK);
    expect(JSON.stringify(writes(calls))).not.toContain('__masked');
  });

  it('a save with nothing changed sends nothing at all, and still returns saved', async () => {
    const calls = dms('editor');
    const navigate = open('edit', 'editor');
    await field(/Vendor Name/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(writes(calls)).toEqual([]);
  });

  it('Replace gives the secret an empty field of its own; a typed value is the only thing sent for it', async () => {
    const calls = dms('owner');
    const navigate = open('edit', 'owner');
    await field(/Vendor Name/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Replace Tax Id' }));
    const tax = await field(/Tax Id/);
    expect(tax).toHaveValue('');
    expect(within(screen.getByTestId('fp-secret-Tax Id')).queryByText('Stored (hidden)')).toBeNull();
    await user.type(tax, '29ABCDE1234F1Z5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(writes(calls)[0]!.body).toEqual(recordCase('update-replaces-a-secret').request.body);
  });

  it('what was typed before Replace is kept, and goes out with the new secret', async () => {
    const calls = dms('owner');
    const navigate = open('edit', 'owner');
    const code = await field(/Vendor Code/);
    const user = userEvent.setup();
    await user.clear(code);
    await user.type(code, '1043');
    await user.click(screen.getByRole('button', { name: 'Replace Tax Id' }));
    expect(await field(/Vendor Code/)).toHaveValue('1043');
    await user.type(await field(/Tax Id/), 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(bodyOf(calls).json_data).toEqual({ 'Vendor Code': '1043', 'Tax Id': 'new-secret' });
  });

  it('Replace then "Keep stored value" takes the field away again, and a save sends nothing for it', async () => {
    const calls = dms('owner');
    const navigate = open('edit', 'owner');
    await field(/Vendor Name/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Replace Tax Id' }));
    await user.type(await field(/Tax Id/), 'abandoned');
    await user.click(screen.getByRole('button', { name: 'Keep stored value of Tax Id' }));
    expect(screen.queryByLabelText(/Tax Id/, { selector: 'input,textarea,select' })).toBeNull();
    expect(within(screen.getByTestId('fp-secret-Tax Id')).getByText('Stored (hidden)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(writes(calls)).toEqual([]);
  });

  it('a replacement that is the mask itself is never sent', async () => {
    const calls = dms('owner');
    const navigate = open('edit', 'owner');
    await field(/Vendor Name/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Replace Tax Id' }));
    await user.type(await field(/Tax Id/), SECRET_MASK);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(writes(calls)).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain(SECRET_MASK);
  });

  it('SECRET_MASK_NOT_ALLOWED and HIDDEN_FIELD_NOT_WRITABLE from dms-api show their message, with the reference, and keep what was typed', async () => {
    for (const code of ['SECRET_MASK_NOT_ALLOWED', 'HIDDEN_FIELD_NOT_WRITABLE']) {
      document.body.innerHTML = '';
      vi.unstubAllGlobals();
      resetTestSession();
      dms('owner', { patch: json(422, { success: false, code, message: 'wording', request_id: '7e000000-0000-4000-8000-0000000000ee' }) });
      const navigate = open('edit', 'owner');
      const codeBox = await field(/Vendor Code/);
      const user = userEvent.setup();
      await user.clear(codeBox);
      await user.type(codeBox, '1043');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('The record was not saved')).toBeInTheDocument();
      expect(screen.getByText('Reference: 7e000000-0000-4000-8000-0000000000ee')).toBeInTheDocument();
      expect(screen.getByLabelText(/Vendor Code/, { selector: 'input,textarea,select' })).toHaveValue('1043');
      expect(navigate).not.toHaveBeenCalled();
    }
  });
});

describe('T-DMSINT-60: adding a record to a master with a secret', () => {
  it('there is nothing stored: the secret is an ordinary empty field, and what is typed is posted (never the mask)', async () => {
    const calls = dms('owner');
    const navigate = open('add', 'owner');
    const name = await field(/Vendor Name/);
    expect(screen.queryByTestId('fp-secret-fields')).toBeNull();
    const user = userEvent.setup();
    await user.type(name, 'Beta');
    await user.type(await field(/Tax Id/), '29ABCDE1234F1Z5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const post = writes(calls)[0]!;
    expect(post.method).toBe('POST');
    expect((post.body as { json_data: Record<string, string> }).json_data).toMatchObject({ 'Vendor Name': 'Beta', 'Tax Id': '29ABCDE1234F1Z5' });
    expect(JSON.stringify(post.body)).not.toContain(SECRET_MASK);
  });

  it('a mask typed into the new secret is posted as an empty string instead', async () => {
    const calls = dms('owner');
    const navigate = open('add', 'owner');
    const user = userEvent.setup();
    await user.type(await field(/Vendor Name/), 'Beta');
    await user.type(await field(/Tax Id/), SECRET_MASK);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect((writes(calls)[0]!.body as { json_data: Record<string, string> }).json_data['Tax Id']).toBe('');
    expect(JSON.stringify(writes(calls))).not.toContain(SECRET_MASK);
  });
});
