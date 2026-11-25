import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { checkDmsV1, elementsToDefinition, type DmsElement } from '@form/registry/profiles/dms-v1';
import type { DmsMasterLookup } from '@form/schema';
import { DmsLookupSettings } from '@/components/builder/DmsLookupSettings';
import { doc } from '@/test/fixtures';
import { loadDocument } from '@/state/history';
import { loadOps, defaultOps } from '@/state/opsStore';
import { resetUi } from '@/state/uiStore';
import { fixtures } from '@/embed/bridge/fixtures';

const A = (n: number) => `a2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = (n: number) => `b2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const el = (n: number, name: string, type = 'textinput'): DmsElement => ({ id: A(n), type, name, value: name, label: name, required: false, placeholder: '', numeric: true, specialChars: true });
const MASTER = 'm-vendors';

beforeEach(() => {
  const def = elementsToDefinition([el(1, 'Vendor'), el(2, 'City'), el(3, 'Phone', 'numberinput'), el(4, 'Notes', 'multilineinput'), el(5, 'Email', 'email')], { formId: 'f', title: 'Orders', locale: 'en-IN' });
  loadDocument(def);
  loadOps(defaultOps());
  resetUi({ started: true });
});

const client = () => ({
  request: vi.fn(async (_method: string, path: string): Promise<never> => {
    if (path === `/dms/v1/master/form/${MASTER}`) return { data: { id: MASTER, form_builder_fields: fixtures.lookup.sourceMasterElements } } as never;
    throw new Error(`unexpected ${path}`);
  }),
});

/** Picks `label` in the NiceSelect named `name`. */
async function pick(user: ReturnType<typeof userEvent.setup>, name: string, label: string | RegExp) {
  await user.click(screen.getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: label }));
}

describe('DmsLookupSettings (Fill from master)', () => {
  it('writes a valid dms_master lookup the profile guard accepts, and offers neither secret nor hidden columns', async () => {
    const api = client();
    const user = userEvent.setup();
    render(<DmsLookupSettings client={api} />);
    await user.click(screen.getByRole('button', { name: 'Add a lookup' }));
    await user.type(screen.getByLabelText('Source master id'), MASTER);
    await user.click(screen.getByRole('button', { name: 'Load fields' }));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('GET', `/dms/v1/master/form/${MASTER}`));
    await pick(user, 'Search field in this form', 'Vendor');
    await user.click(screen.getByRole('combobox', { name: 'Column people search and pick by' }));
    const listed = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(listed).toEqual(expect.arrayContaining(['Vendor Name', 'City', 'Phone']));
    expect(listed).not.toContain('Tax Id');
    expect(listed).not.toContain('Internal Note');
    await user.click(screen.getByRole('option', { name: 'Vendor Name' }));
    await user.click(screen.getByRole('button', { name: 'Add a field to fill' }));
    await pick(user, 'Source column 1', 'City');
    await pick(user, 'Field in this form 1', 'City');
    await user.click(screen.getByRole('button', { name: 'Add a field to fill' }));
    await pick(user, 'Source column 2', 'Phone');
    await pick(user, 'Field in this form 2', 'Phone');
    await user.click(screen.getByRole('button', { name: 'Save lookup' }));
    const saved = (doc().lookups ?? []) as DmsMasterLookup[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ source: 'dms_master', enabled: true, masterId: MASTER, pickerFieldId: A(1), pickerKey: B(1), minChars: 2 });
    expect(saved[0]!.mappings).toEqual([{ key: B(2), fieldId: A(2) }, { key: B(3), fieldId: A(3) }]);
    expect(checkDmsV1(doc()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('the fields to fill are text, multi-line and number fields: not the search field, not an email field', async () => {
    const user = userEvent.setup();
    render(<DmsLookupSettings client={client()} />);
    await user.click(screen.getByRole('button', { name: 'Add a lookup' }));
    await user.type(screen.getByLabelText('Source master id'), MASTER);
    await user.click(screen.getByRole('button', { name: 'Load fields' }));
    await pick(user, 'Search field in this form', 'Vendor');
    await user.click(screen.getByRole('button', { name: 'Add a field to fill' }));
    await user.click(screen.getByRole('combobox', { name: 'Field in this form 1' }));
    const listed = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(listed).toEqual(expect.arrayContaining(['City', 'Phone', 'Notes']));
    expect(listed).not.toContain('Vendor');
    expect(listed).not.toContain('Email');
  });

  it('cannot be saved while incomplete, and a failed master read says so', async () => {
    const api = { request: vi.fn(async () => { throw new Error('403'); }) };
    const user = userEvent.setup();
    render(<DmsLookupSettings client={api} />);
    await user.click(screen.getByRole('button', { name: 'Add a lookup' }));
    expect(screen.getByRole('button', { name: 'Save lookup' })).toBeDisabled();
    await user.type(screen.getByLabelText('Source master id'), MASTER);
    await user.click(screen.getByRole('button', { name: 'Load fields' }));
    expect(await screen.findByText(/The master could not be read/)).toBeInTheDocument();
    expect(doc().lookups).toBeUndefined();
  });

  it('lists a saved lookup and removes it', async () => {
    const user = userEvent.setup();
    const def = elementsToDefinition([{ ...el(1, 'Vendor'), fp_lookup: { v: 1, id: 'vendor', master_id: MASTER, label_field_id: B(1), fill: [{ from: B(2), to: A(2) }], min_chars: 2 } }, el(2, 'City')], { formId: 'f', title: 'Orders', locale: 'en-IN' });
    loadDocument(def);
    render(<DmsLookupSettings client={client()} />);
    const row = screen.getByText(/Vendor ← m-vendors/);
    expect(row).toBeInTheDocument();
    await user.click(within(row.parentElement!).getByRole('button', { name: 'Remove lookup' }));
    expect(doc().lookups ?? []).toEqual([]);
  });
});
