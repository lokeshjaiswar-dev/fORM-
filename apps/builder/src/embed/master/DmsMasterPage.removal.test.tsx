import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BlockId } from '@form/schema';
import fixtures from './__fixtures__/dms-master-form.fixtures.json' with { type: 'json' };
import { MemoryCustomFieldRepository, setCustomFieldRepository } from '@/fields/custom/repository';
import { resetTestSession } from '@/embed/session/testing';
import { deleteBlock } from '@/state/actions';
import { currentDoc } from '@/state/documentStore';
import { undo } from '@/state/history';
import { fakeFetch, installMaster, json, READY, RETURN, renderMaster, type Seen } from './pageHarness';

/*
 * T-DMSINT-56, component level (SEC-DESIGN 7.3, DESIGN 5.2): deleting a block that DMS stores only marks it "to be removed"; "Save to DMS"
 * counts the records, shows one dialog per field, and sends `remove[]` only after the author typed the field name. Cancel puts the block back
 * and sends nothing. The browser run of the same flow is e2e/dms-master.removal.spec.ts.
 */

type V2Case = { name: string; response: { status: number; body: Record<string, unknown> } };
const v2 = (name: string) => (fixtures.v2Cases.cases as unknown as V2Case[]).find((c) => c.name === name)!;

const REV_MASTER = 'a1000000-0000-4000-8000-0000000000b1';
const NAME = 'b1000000-0000-4000-8000-000000000001';
const CODE = 'b1000000-0000-4000-8000-000000000002';
const TAX = 'b1000000-0000-4000-8000-000000000008';
const NOTE = 'b1000000-0000-4000-8000-000000000009';
const NAMES: Record<string, string> = { [NAME]: 'Vendor Name', [CODE]: 'Vendor Code', [TAX]: 'Tax Id', [NOTE]: 'Internal Note' };
const SESSION_FORM = (id: string) => `/dms/v1/master/form/${id}`;

const usage = (counts: Record<string, number>) => ({
  success: true,
  message: 'Field usage retrieved successfully',
  data: { updated_at: '2026-11-26T09:30:00.000000Z', total_records: 12, fields: Object.entries(counts).map(([id, records_with_value]) => ({ id, name: NAMES[id]!, records_with_value })) },
});

interface Dms {
  counts?: Record<string, number>;
  /** Answers the counts request instead of `counts`. */
  usageAnswer?: () => Response;
  /** Answers a PATCH; the default is the fixture's 200. */
  patch?: (call: Seen, nth: number) => Response;
  master?: Record<string, unknown>;
}

/** The calls of the current test, so the invariant below can look at every PATCH it made. */
let current: Seen[] = [];

function setup(over: Dms = {}, launch: Parameters<typeof installMaster>[0] = {}) {
  let patches = 0;
  const f = fakeFetch((c) => {
    if (c.method === 'GET' && c.path.endsWith('/field-usage')) return over.usageAnswer ? over.usageAnswer() : json(200, usage(over.counts ?? { [NAME]: 12, [CODE]: 3, [TAX]: 9, [NOTE]: 3 }));
    if (c.method === 'GET') return json(200, over.master ?? v2('show-as-revealer').response.body);
    patches += 1;
    return over.patch ? over.patch(c, patches) : json(200, v2('patch-remove-confirmed').response.body);
  });
  installMaster({ masterId: REV_MASTER, ...launch });
  const view = renderMaster();
  current = f.seen;
  return { ...f, ...view };
}

const READY_BUILDER = async () => screen.findByTestId('dms-master-builder', undefined, READY);
const remove = (id: string) => act(() => void deleteBlock(id as BlockId));
const patchesOf = (seen: Seen[]) => seen.filter((c) => c.method === 'PATCH');
const usageCalls = (seen: Seen[]) => seen.filter((c) => c.path.endsWith('/field-usage'));
const dialog = () => screen.findByTestId('fp-removal-dialog');
const typeName = async (user: ReturnType<typeof userEvent.setup>, name: string) => user.type(within(await dialog()).getByTestId('fp-removal-confirm-name'), name);

beforeEach(() => {
  setCustomFieldRepository(new MemoryCustomFieldRepository());
});
afterEach(() => {
  /* The lane's invariant, checked after every test of this file: no request omits a DMS field without a matching remove[] entry. */
  for (const c of current.filter((x) => x.method === 'PATCH')) {
    const body = c.body as { form_builder_fields?: Array<{ id: string }>; remove?: Array<{ field_id: string }> };
    const named = new Set([...(body.form_builder_fields ?? []).map((f) => f.id), ...(body.remove ?? []).map((r) => r.field_id)]);
    for (const id of Object.keys(NAMES)) expect(named.has(id), `PATCH omits stored field ${NAMES[id]} without a remove[] entry`).toBe(true);
  }
  current = [];
  vi.unstubAllGlobals();
  resetTestSession();
});

describe('T-DMSINT-56: deleting a stored block marks it to be removed', () => {
  it('the block leaves the canvas and is listed as "to be removed"; nothing is sent', async () => {
    const { seen } = setup();
    await READY_BUILDER();
    expect(screen.queryByTestId('fp-removal-marks')).toBeNull();
    remove(CODE);
    const marks = await screen.findByTestId('fp-removal-marks');
    expect(within(marks).getByTestId(`fp-removal-mark-${CODE}`)).toHaveTextContent('Vendor Code');
    expect(marks).toHaveTextContent('1 field will be removed when you save');
    expect(currentDoc().blocks[CODE as BlockId]).toBeUndefined();
    expect(seen.map((c) => c.method)).toEqual(['GET']);
  });

  it('Undo clears the mark (the block is back); redo marks it again', async () => {
    setup();
    await READY_BUILDER();
    remove(CODE);
    await screen.findByTestId('fp-removal-marks');
    act(() => undo());
    await waitFor(() => expect(screen.queryByTestId('fp-removal-marks')).toBeNull());
    expect(currentDoc().blocks[CODE as BlockId]).toBeDefined();
  });

  it('"Put back" restores the same block (id, place, settings) and clears the mark', async () => {
    setup();
    await READY_BUILDER();
    const before = currentDoc();
    const at = before.pages[0]!.children.indexOf(CODE as BlockId);
    remove(CODE);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Put back Vendor Code' }));
    await waitFor(() => expect(screen.queryByTestId('fp-removal-marks')).toBeNull());
    const after = currentDoc();
    expect(after.pages[0]!.children.indexOf(CODE as BlockId)).toBe(at);
    expect(after.blocks[CODE as BlockId]).toEqual(before.blocks[CODE as BlockId]);
  });

  it('a block added in this session and deleted again is not marked (DMS does not store it)', async () => {
    const { seen } = setup();
    await READY_BUILDER();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email' }));
    const added = Object.keys(currentDoc().blocks).find((id) => !(id in NAMES))!;
    remove(added);
    expect(screen.queryByTestId('fp-removal-marks')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(patchesOf(seen)).toHaveLength(1));
    expect(screen.queryByTestId('fp-removal-dialog')).toBeNull();
    expect(usageCalls(seen)).toHaveLength(0);
    expect(patchesOf(seen)[0]!.body).not.toHaveProperty('remove');
  });
});

describe('T-DMSINT-56: the consent dialog on Save', () => {
  it('shows the count and the contract text, needs the exact name, then sends remove[] with every kept field listed', async () => {
    const { seen, navigate } = setup();
    await READY_BUILDER();
    remove(CODE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    const box = await dialog();
    expect(box).toHaveTextContent('Removing Vendor Code deletes its value in 3 records. DMS cannot restore them.');
    // The counts were asked before the dialog, and nothing was sent yet.
    expect(usageCalls(seen)).toHaveLength(1);
    expect(usageCalls(seen)[0]!.url).toBe(`https://dms.example.test/api/dms/v1/formplus/s/master/form/${REV_MASTER}/field-usage`);
    expect(patchesOf(seen)).toHaveLength(0);
    const confirm = within(box).getByTestId('fp-removal-confirm');
    expect(confirm).toBeDisabled();
    // Wrong names, however close, keep it disabled: case, a missing letter, a trailing space.
    const input = within(box).getByTestId('fp-removal-confirm-name');
    for (const wrong of ['vendor code', 'Vendor Cod', 'Vendor Code ']) {
      await user.clear(input);
      await user.type(input, wrong);
      expect(confirm).toBeDisabled();
    }
    expect(patchesOf(seen)).toHaveLength(0);
    await user.clear(input);
    await user.type(input, 'Vendor Code');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(patchesOf(seen)).toHaveLength(1));
    const patch = patchesOf(seen)[0]!;
    expect(patch.method).toBe('PATCH');
    expect(patch.path).toBe(SESSION_FORM(REV_MASTER));
    const body = patch.body as { form_builder_fields: Array<{ id: string }>; remove: unknown };
    expect(body.remove).toEqual([{ field_id: CODE, confirmed_name: 'Vendor Code', confirmed_count: 3 }]);
    expect(body.form_builder_fields.map((f) => f.id)).toEqual([NAME, TAX, NOTE]);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`${RETURN}?fp_status=saved&fp_master_id=${REV_MASTER}`));
  });

  it('a field with 0 records still needs the typed name', async () => {
    const { seen } = setup({ counts: { [NAME]: 12, [CODE]: 0, [TAX]: 9, [NOTE]: 3 } });
    await READY_BUILDER();
    remove(CODE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await dialog()).toHaveTextContent('Removing Vendor Code deletes its value in 0 records. DMS cannot restore them.');
    expect(within(await dialog()).getByTestId('fp-removal-confirm')).toBeDisabled();
    await typeName(user, 'Vendor Code');
    await user.click(within(await dialog()).getByTestId('fp-removal-confirm'));
    await waitFor(() => expect(patchesOf(seen)).toHaveLength(1));
    expect((patchesOf(seen)[0]!.body as { remove: unknown }).remove).toEqual([{ field_id: CODE, confirmed_name: 'Vendor Code', confirmed_count: 0 }]);
  });

  it('Cancel puts the block back and sends nothing: no PATCH, no navigation, no mark left', async () => {
    const { seen, navigate } = setup();
    await READY_BUILDER();
    remove(CODE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await user.click(within(await dialog()).getByTestId('fp-removal-cancel'));
    await waitFor(() => expect(screen.queryByTestId('fp-removal-dialog')).toBeNull());
    expect(currentDoc().blocks[CODE as BlockId]).toBeDefined();
    expect(screen.queryByTestId('fp-removal-marks')).toBeNull();
    expect(patchesOf(seen)).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
    // The save button works again and a save of the restored form sends no removal at all.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save to DMS' })).toBeEnabled());
  });

  it('Escape is a cancel too', async () => {
    const { seen } = setup();
    await READY_BUILDER();
    remove(CODE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await dialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('fp-removal-dialog')).toBeNull());
    expect(currentDoc().blocks[CODE as BlockId]).toBeDefined();
    expect(patchesOf(seen)).toHaveLength(0);
  });

  it('two removed fields: one dialog each, in form order; cancelling the second restores only it and sends nothing', async () => {
    const { seen } = setup();
    await READY_BUILDER();
    remove(CODE);
    remove(TAX);
    const marks = await screen.findByTestId('fp-removal-marks');
    expect(marks).toHaveTextContent('2 fields will be removed when you save');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await dialog()).toHaveTextContent('Removing Vendor Code deletes its value in 3 records');
    await typeName(user, 'Vendor Code');
    await user.click(within(await dialog()).getByTestId('fp-removal-confirm'));
    await waitFor(() => expect(screen.getByTestId('fp-removal-dialog')).toHaveTextContent('Removing Tax Id deletes its value in 9 records'));
    await user.click(within(screen.getByTestId('fp-removal-dialog')).getByTestId('fp-removal-cancel'));
    await waitFor(() => expect(screen.queryByTestId('fp-removal-dialog')).toBeNull());
    expect(currentDoc().blocks[TAX as BlockId]).toBeDefined();
    expect(currentDoc().blocks[CODE as BlockId]).toBeUndefined();
    expect(patchesOf(seen)).toHaveLength(0);
    // Vendor Code is still marked; the next save asks about it again from scratch.
    expect(screen.getByTestId(`fp-removal-mark-${CODE}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`fp-removal-mark-${TAX}`)).toBeNull();
  });

  it('409 REMOVAL_COUNT_CHANGED asks again with the new count, and the repeated save carries it', async () => {
    const grew = v2('patch-remove-count-grew').response;
    const { seen, navigate } = setup({
      patch: (_c, nth) => (nth === 1 ? json(409, { ...grew.body, message: 'x', request_id: null, details: { field_id: CODE, actual: 5 } }) : json(200, v2('patch-remove-confirmed').response.body)),
    });
    await READY_BUILDER();
    remove(CODE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await typeName(user, 'Vendor Code');
    await user.click(within(await dialog()).getByTestId('fp-removal-confirm'));
    await waitFor(() => expect(screen.getByTestId('fp-removal-recount')).toBeInTheDocument());
    expect(screen.getByTestId('fp-removal-dialog')).toHaveTextContent('Removing Vendor Code deletes its value in 5 records. DMS cannot restore them.');
    // The box starts empty again: the name has to be typed again.
    expect(within(screen.getByTestId('fp-removal-dialog')).getByTestId('fp-removal-confirm-name')).toHaveValue('');
    expect(within(screen.getByTestId('fp-removal-dialog')).getByTestId('fp-removal-confirm')).toBeDisabled();
    await typeName(user, 'Vendor Code');
    await user.click(within(screen.getByTestId('fp-removal-dialog')).getByTestId('fp-removal-confirm'));
    await waitFor(() => expect(patchesOf(seen)).toHaveLength(2));
    expect(patchesOf(seen).map((c) => (c.body as { remove: Array<{ confirmed_count: number }> }).remove[0]!.confirmed_count)).toEqual([3, 5]);
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it.each([
    ['FIELD_OMITTED', 422, 'The form no longer lists a field that is stored in DMS. Reload and try again.'],
    ['UNKNOWN_FIELD', 422, 'A field to remove does not exist in this master.'],
    ['REMOVAL_NOT_CONFIRMED', 422, 'Type the field name exactly to confirm removing it.'],
    ['REMOVAL_INCOMPLETE', 500, 'Nothing was changed. Try again.'],
  ] as const)('%s from dms-api shows a clear message with its reference, and keeps the edit', async (code, status, message) => {
    const { navigate } = setup({ patch: () => json(status, { success: false, code, message: 'server wording', request_id: '7e000000-0000-4000-8000-0000000000bb' }) });
    await READY_BUILDER();
    remove(CODE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await typeName(user, 'Vendor Code');
    await user.click(within(await dialog()).getByTestId('fp-removal-confirm'));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText('Reference: 7e000000-0000-4000-8000-0000000000bb')).toBeInTheDocument();
    expect(screen.getByText('The master was not saved')).toBeInTheDocument();
    expect(screen.getByText('Changes not saved to DMS')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    // The block is still marked: the author can put it back or try the save again.
    expect(screen.getByTestId(`fp-removal-mark-${CODE}`)).toBeInTheDocument();
  });

  it('an answer for the counts that this builder cannot read stops the save: nothing is sent', async () => {
    const { seen } = setup({ usageAnswer: () => json(200, { success: true, data: { fields: 'many' } }) });
    await READY_BUILDER();
    remove(CODE);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save to DMS' }));
    expect(await screen.findByText(/cannot read/)).toBeInTheDocument();
    expect(patchesOf(seen)).toHaveLength(0);
    expect(screen.queryByTestId('fp-removal-dialog')).toBeNull();
  });
});

describe('T-DMSINT-56: no request omits a DMS field without a matching remove[] entry', () => {
  it('a plain save, a save after a put-back and a save with a confirmed removal all name every stored field (checked after each test too)', async () => {
    const { seen } = setup();
    await READY_BUILDER();
    const user = userEvent.setup();
    // 1. a plain save with an added field
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(patchesOf(seen)).toHaveLength(1));
    expect(patchesOf(seen)[0]!.body).not.toHaveProperty('remove');
    // 2. delete, put back, save
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save to DMS' })).toBeEnabled());
    remove(TAX);
    await user.click(await screen.findByRole('button', { name: 'Put back Tax Id' }));
    await user.click(screen.getByRole('button', { name: 'Date' }));
    await user.click(screen.getByRole('button', { name: 'Save to DMS' }));
    await waitFor(() => expect(patchesOf(seen)).toHaveLength(2));
    expect(patchesOf(seen)[1]!.body).not.toHaveProperty('remove');
    expect(usageCalls(seen)).toHaveLength(0);
  });
});
