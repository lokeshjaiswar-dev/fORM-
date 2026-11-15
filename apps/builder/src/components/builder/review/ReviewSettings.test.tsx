import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { reviewUnitMembership } from '@form/logic';
import type { BlockId, FormDefinition, PageId, ReviewGroupId, ReviewSettings as Settings, ReviewUnit, ReviewUnitId, StoredBlock } from '@form/schema';
import { useSessionStore, type Me } from '@/auth/client';
import { ReviewSettings } from '@/components/builder/review/ReviewSettings';
import { loadDocument, undo } from '@/state/history';
import { block, doc, formWith, resetStore } from '@/test/fixtures';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

const FORM = 'test';
const FINANCE = '01970000-0000-7000-8000-0000000000a1';
const LEGAL = '01970000-0000-7000-8000-0000000000a2';
const groupView = (id: string, name: string, archivedAt: string | null = null) => ({ id, name, createdAt: '2026-11-01T00:00:00.000Z', archivedAt, members: [] });

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => json(status, { type: 'about:blank', title: code, status, code, ...extra });

/**
 * The API behind the tab as far as the tab talks to it: a form's review settings (a save needs the right `If-Match`, as
 * the real one does) and the org's review groups. `stale` makes the next save lose to someone else's.
 */
function fakeApi(o: { rev?: number; settings?: Settings; groups?: unknown[]; missing?: boolean; groupsForbidden?: boolean; stale?: boolean; refuse?: (body: Settings) => Response | null } = {}) {
  const calls: Call[] = [];
  let rev = o.rev ?? 3;
  let settings: Settings = o.settings ?? { enabled: false, distinctCheckers: false, units: [] };
  let stale = o.stale ?? false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url, headers: (init.headers ?? {}) as Record<string, string>, body });
      if (url === '/v1/org/review-groups' && method === 'GET') {
        return Promise.resolve(o.groupsForbidden ? problem(403, 'FORBIDDEN', { detail: 'Requires members.manage or submissions.review.' }) : json(200, { items: o.groups ?? [groupView(FINANCE, 'Finance'), groupView(LEGAL, 'Legal')] }));
      }
      if (url === `/v1/forms/${FORM}/review`) {
        if (o.missing) return Promise.resolve(problem(404, 'NOT_FOUND', { detail: 'That form is not in this organisation.' }));
        if (method === 'GET') return Promise.resolve(json(200, { rev, ...settings }));
        if (method === 'PUT') {
          if (stale) {
            // Someone else saved first: the stored settings moved on.
            stale = false;
            rev += 1;
            settings = { ...settings, distinctCheckers: true };
            return Promise.resolve(problem(409, 'REVIEW_SETTINGS_CONFLICT', { detail: 'The review settings changed since you read them.' }));
          }
          if ((init.headers as Record<string, string>)['if-match'] !== `"${rev}"`) return Promise.resolve(problem(409, 'REVIEW_SETTINGS_CONFLICT'));
          const refused = o.refuse?.(body as Settings);
          if (refused) return Promise.resolve(refused);
          settings = body as Settings;
          rev += 1;
          return Promise.resolve(json(200, { rev, ...settings }));
        }
      }
      return Promise.resolve(problem(404, 'NOT_FOUND'));
    }),
  );
  return { calls, called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

/** A payment block. The registry does not offer one yet (WP-2.11), and the unit checks look only at the block's type. */
const payment = (id: string) => ({ ...block('short_text', id), type: 'payment' }) as unknown as StoredBlock;
/** The settings a call sent. */
const sentSettings = (call: Call | undefined): Settings => call?.body as Settings;
const unit = (id: string, name: string, target: ReviewUnit['target']): ReviewUnit => ({ id: id as ReviewUnitId, name, target });
const page = (id: string): ReviewUnit['target'] => ({ kind: 'page', pageId: id as PageId });
const brk = (id: string): ReviewUnit['target'] => ({ kind: 'section_break', blockId: id as BlockId });
const assignment = (unitId: string, groupId: string, over: Partial<Settings['units'][number]> = {}): Settings['units'][number] => ({
  unitId: unitId as ReviewUnitId,
  groupId: groupId as ReviewGroupId,
  order: 1,
  required: true,
  visibility: 'own_unit',
  ...over,
});

/** Page 1 holds a name, a section break and an email; page 2 a second break and a phone. */
function twoPages(review?: ReviewUnit[]): FormDefinition {
  const form = formWith([
    [block('short_text', 'name', { label: 'Full name' }), block('section_break', 'sbA', { config: { name: 'Section A' } }), block('short_text', 'email', { label: 'Email' })],
    [block('section_break', 'sbB', { config: { name: 'Section B' } }), block('short_text', 'phone', { label: 'Phone' })],
  ]);
  return review ? { ...form, review: { units: review } } : form;
}

/** Opens `def` with a fresh history, on the default local ops and UI (`resetStore` loads a blank form first). */
const open = (def: FormDefinition) => {
  resetStore();
  loadDocument(def);
};

async function ready() {
  expect(await screen.findByRole('switch', { name: 'Review responses before they count' })).toBeEnabled();
}

beforeEach(() => {
  resetStore();
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('ReviewSettings: the units', () => {
  it('adds a page unit and a section break unit to the draft, and undo takes them back one at a time', async () => {
    open(twoPages());
    fakeApi();
    const user = userEvent.setup();
    render(<ReviewSettings />);
    await ready();
    expect(doc().review).toBeUndefined();
    expect(screen.getByText('No review units yet. Make one from a page or a section break.')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Part of the form to check' }));
    await user.click(await screen.findByRole('option', { name: 'Page 2' }));
    await user.click(screen.getByRole('button', { name: 'Add review unit' }));
    expect(doc().review?.units).toEqual([{ id: expect.any(String), name: 'Page 2', target: { kind: 'page', pageId: 'page_2' } }]);
    expect(screen.getByRole('combobox', { name: 'Part of the form to check' })).toHaveTextContent('Choose a page or section break…');

    await user.click(screen.getByRole('combobox', { name: 'Part of the form to check' }));
    // What already has a unit is not offered again.
    expect(screen.queryByRole('option', { name: 'Page 2' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Section break: Section A' }));
    await user.click(screen.getByRole('button', { name: 'Add review unit' }));
    expect(doc().review?.units).toEqual([
      { id: expect.any(String), name: 'Page 2', target: { kind: 'page', pageId: 'page_2' } },
      { id: expect.any(String), name: 'Section A', target: { kind: 'section_break', blockId: 'sbA' } },
    ]);
    const ids = doc().review?.units.map((u) => u.id) ?? [];
    expect(new Set(ids).size).toBe(2);

    undo();
    expect(doc().review?.units.map((u) => u.name)).toEqual(['Page 2']);
    undo();
    expect(doc().review).toBeUndefined();
  });

  it('renames a unit as one undoable step and deletes it, taking review out of the draft with the last unit', async () => {
    open(twoPages([unit('u1', 'Page 2', page('page_2'))]));
    fakeApi();
    const user = userEvent.setup();
    render(<ReviewSettings />);
    await ready();

    const name = screen.getByLabelText('Name of the review unit for Page 2');
    await user.clear(name);
    // An empty name is not taken: the draft keeps the last good one.
    expect(doc().review?.units[0]?.name).toBe('Page 2');
    await user.type(name, 'Contact details');
    expect(doc().review?.units[0]?.name).toBe('Contact details');
    undo();
    expect(doc().review?.units[0]?.name).toBe('Page 2');

    await user.click(screen.getByRole('button', { name: 'Delete the review unit for Page 2' }));
    expect(doc().review).toBeUndefined();
    undo();
    expect(doc().review?.units).toHaveLength(1);
  });

  it('shows the overlap warning on both units and lists exactly the blocks reviewUnitMembership returns', async () => {
    // Page 1 holds Section A, so the Section A unit and the Page 1 unit hold the same questions.
    const def = twoPages([unit('u1', 'Applicant', page('page_1')), unit('u2', 'Section A part', brk('sbA')), unit('u3', 'Section B part', brk('sbB'))]);
    open(def);
    fakeApi();
    render(<ReviewSettings />);
    await ready();

    const overlap = screen.getAllByText(/shares questions with/);
    expect(overlap).toHaveLength(2);
    expect(overlap[0]).toHaveTextContent('This unit shares questions with “Section A part”. A question can belong to only one unit. The form cannot be published like this.');
    expect(overlap[1]).toHaveTextContent('This unit shares questions with “Applicant”.');
    // The unit that overlaps nothing has no warning.
    const cardOf = (label: string) => screen.getByLabelText(label).closest('li[data-unit-id]') as HTMLElement;
    expect(within(cardOf('Name of the review unit for Section break: Section B')).queryByText(/shares questions/)).not.toBeInTheDocument();

    const membership = reviewUnitMembership(def);
    expect(membership).toEqual({ u1: ['name', 'sbA', 'email'], u2: ['sbA', 'email'], u3: ['sbB', 'phone'] });
    for (const [unitId, target] of [['u1', 'Page 1'], ['u2', 'Section break: Section A'], ['u3', 'Section break: Section B']] as const) {
      const list = screen.getByRole('list', { name: `Blocks in ${target}` });
      const shown = [...list.querySelectorAll('[data-block-id]')];
      expect(shown.map((li) => li.getAttribute('data-block-id'))).toEqual(membership[unitId as ReviewUnitId]);
    }
    expect([...screen.getByRole('list', { name: 'Blocks in Page 1' }).querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Full name', 'Section A', 'Email']);
  });

  it('says in words when a unit covers nothing, holds a payment, or points at a page that is gone', async () => {
    const def = formWith([[block('short_text', 'a', { label: 'A' })], [payment('pay')], []]);
    open({ ...def, review: { units: [unit('pay', 'Payment page', page('page_2')), unit('none', 'Empty page', page('page_3')), unit('gone', 'Old page', page('page_9'))] } });
    fakeApi();
    render(<ReviewSettings />);
    await ready();
    expect(screen.getByText(/This unit covers a payment\./)).toBeInTheDocument();
    expect(screen.getByText(/This unit covers no questions, so there is nothing to check\./)).toBeInTheDocument();
    expect(screen.getByText(/The page or section break this unit was made from is no longer in the form\./)).toBeInTheDocument();
    // A unit that points at nothing covers nothing: no empty list of blocks is shown for it.
    expect(screen.queryByRole('list', { name: /Blocks in A page or section break that is no longer/ })).not.toBeInTheDocument();
  });
});

describe('ReviewSettings: who reviews', () => {
  const UNITS = [unit('u1', 'Page 1', page('page_1')), unit('u2', 'Page 2', page('page_2'))];

  it('loads the assignments, saves a change with If-Match, and shows the saved revision', async () => {
    open({ ...twoPages(), review: { units: UNITS } });
    const api = fakeApi({ rev: 3, settings: { enabled: true, distinctCheckers: false, units: [assignment('u1', FINANCE, { order: 2 })] } });
    const user = userEvent.setup();
    render(<ReviewSettings />);
    await ready();
    expect(api.called('GET', '/v1/forms/test/review')).toHaveLength(1);
    expect(api.called('GET', '/v1/forms/test/review')[0]?.headers).toMatchObject({ 'x-fr-org': 'o1' });
    expect(screen.getByRole('switch', { name: 'Review responses before they count' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Group that checks Page 1' })).toHaveTextContent('Finance');
    expect(screen.getByLabelText('Order for Page 1')).toHaveValue(2);
    expect(screen.getByRole('button', { name: 'Save review settings' })).toBeDisabled();

    // Page 2 gets its first group: it starts required, first in order, seeing only its own unit.
    await user.click(screen.getByRole('combobox', { name: 'Group that checks Page 2' }));
    await user.click(await screen.findByRole('option', { name: 'Legal' }));
    await user.click(screen.getByRole('switch', { name: 'Required for Page 2' }));
    await user.click(screen.getByRole('combobox', { name: 'What the checker of Page 2 sees' }));
    await user.click(await screen.findByRole('option', { name: 'The whole response' }));
    await user.clear(screen.getByLabelText('Order for Page 2'));
    await user.type(screen.getByLabelText('Order for Page 2'), '3');
    await user.click(screen.getByRole('switch', { name: 'One checker decides only one unit per response' }));
    await user.click(screen.getByRole('button', { name: 'Save review settings' }));

    expect(await screen.findByText('Review settings saved.')).toBeInTheDocument();
    const [put] = api.called('PUT', '/v1/forms/test/review');
    expect(put?.headers).toMatchObject({ 'if-match': '"3"', 'x-fr-org': 'o1', 'x-fr-client': 'builder' });
    expect(put?.body).toEqual({
      enabled: true,
      distinctCheckers: true,
      units: [assignment('u1', FINANCE, { order: 2 }), assignment('u2', LEGAL, { order: 3, required: false, visibility: 'whole_submission' })],
    });
    expect(screen.getByRole('button', { name: 'Save review settings' })).toBeDisabled();

    // The next save names the revision this one produced.
    await user.click(screen.getByRole('button', { name: 'Remove the group of Page 1' }));
    expect(screen.getByRole('combobox', { name: 'Group that checks Page 1' })).toHaveTextContent('Choose a group');
    await user.click(screen.getByRole('button', { name: 'Save review settings' }));
    await waitFor(() => expect(api.called('PUT', '/v1/forms/test/review')).toHaveLength(2));
    expect(api.called('PUT', '/v1/forms/test/review')[1]?.headers).toMatchObject({ 'if-match': '"4"' });
    expect(sentSettings(api.called('PUT', '/v1/forms/test/review')[1]).units.map((a) => a.unitId)).toEqual(['u2']);
  });

  it('offers a reload when someone saved first, and shows their settings after it', async () => {
    open({ ...twoPages(), review: { units: UNITS } });
    const api = fakeApi({ rev: 3, stale: true });
    const user = userEvent.setup();
    render(<ReviewSettings />);
    await ready();
    await user.click(screen.getByRole('combobox', { name: 'Group that checks Page 1' }));
    await user.click(await screen.findByRole('option', { name: 'Finance' }));
    await user.click(screen.getByRole('button', { name: 'Save review settings' }));

    expect(await screen.findByText(/These settings were changed somewhere else, so yours were not saved\./)).toBeInTheDocument();
    expect(api.called('GET', '/v1/forms/test/review')).toHaveLength(1);
    // Nothing was overwritten: their change is still the server's, and mine is still on screen until the author reloads.
    expect(screen.getByRole('combobox', { name: 'Group that checks Page 1' })).toHaveTextContent('Finance');
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Reloaded. These are the settings as they are now.')).toBeInTheDocument();
    expect(api.called('GET', '/v1/forms/test/review')).toHaveLength(2);
    expect(screen.getByRole('switch', { name: 'One checker decides only one unit per response' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Group that checks Page 1' })).not.toHaveTextContent('Finance');
    expect(screen.queryByText(/changed somewhere else/)).not.toBeInTheDocument();
  });

  it('turns the assignment controls off while the form is not on the server, and says why; the units can still be edited', async () => {
    open({ ...twoPages(), review: { units: UNITS } });
    const api = fakeApi({ missing: true });
    const user = userEvent.setup();
    render(<ReviewSettings />);
    expect(await screen.findByText('This form is not on the server yet, so groups cannot be chosen. It saves by itself a moment after you edit it.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Group that checks Page 1' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Review responses before they count' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save review settings' })).toBeDisabled();

    await user.clear(screen.getByLabelText('Name of the review unit for Page 1'));
    await user.type(screen.getByLabelText('Name of the review unit for Page 1'), 'Applicant');
    expect(doc().review?.units[0]?.name).toBe('Applicant');

    // Once the form is there, "Try again" reads the settings.
    vi.unstubAllGlobals();
    fakeApi();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await ready();
    expect(screen.getByRole('combobox', { name: 'Group that checks Page 1' })).toBeEnabled();
    expect(api.called('GET', '/v1/forms/test/review')).toHaveLength(1);
  });

  it('keeps the assignments of units that are not in this draft, and names a group that is gone instead of saving it', async () => {
    open({ ...twoPages(), review: { units: [UNITS[0]!] } });
    const GONE = '01970000-0000-7000-8000-0000000000ff';
    const api = fakeApi({ settings: { enabled: true, distinctCheckers: false, units: [assignment('u1', GONE), assignment('live-only', FINANCE)] } });
    const user = userEvent.setup();
    render(<ReviewSettings />);
    await ready();
    expect(screen.getByText('1 assignment belongs to a unit that is not in this draft. It is kept, because the published version may still use it.')).toBeInTheDocument();
    // The group of Page 1 was archived since: it is not offered, the author is told, and the save waits for a choice.
    expect(screen.getByText('This unit’s group no longer exists or is archived. Choose another group.')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'One checker decides only one unit per response' }));
    expect(screen.getByRole('button', { name: 'Save review settings' })).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'Group that checks Page 1' }));
    await user.click(await screen.findByRole('option', { name: 'Legal' }));
    await user.click(screen.getByRole('button', { name: 'Save review settings' }));
    await screen.findByText('Review settings saved.');
    expect(sentSettings(api.called('PUT', '/v1/forms/test/review')[0]).units).toEqual([assignment('u1', LEGAL), assignment('live-only', FINANCE)]);
  });

  it('drops an assignment the server refuses because its unit is in no version any more, and sends the rest', async () => {
    open({ ...twoPages(), review: { units: [UNITS[0]!] } });
    const refuse = (body: Settings) =>
      body.units.some((a) => a.unitId === 'stale')
        ? problem(400, 'VALIDATION_FAILED', { detail: 'bad', errors: [{ path: `body/units/${body.units.findIndex((a) => a.unitId === 'stale')}/unitId`, message: 'this form has no review unit with this id, in its draft or its live version' }] })
        : null;
    const api = fakeApi({ settings: { enabled: false, distinctCheckers: false, units: [assignment('u1', FINANCE), assignment('stale', LEGAL)] }, refuse });
    const user = userEvent.setup();
    render(<ReviewSettings />);
    await ready();
    await user.click(screen.getByRole('switch', { name: 'Review responses before they count' }));
    await user.click(screen.getByRole('button', { name: 'Save review settings' }));
    expect(await screen.findByText('Review settings saved.')).toBeInTheDocument();
    const puts = api.called('PUT', '/v1/forms/test/review');
    expect(puts).toHaveLength(2);
    expect(sentSettings(puts[0]).units.map((a) => a.unitId)).toEqual(['u1', 'stale']);
    expect(puts[1]?.body).toEqual({ enabled: true, distinctCheckers: false, units: [assignment('u1', FINANCE)] });
  });

  it('shows a refusal about a unit in this draft instead of working around it', async () => {
    open({ ...twoPages(), review: { units: UNITS } });
    const refuse = () => problem(400, 'VALIDATION_FAILED', { detail: 'bad', errors: [{ path: 'body/units/0/groupId', message: 'no such review group in this org, or it is archived' }] });
    fakeApi({ refuse });
    const user = userEvent.setup();
    render(<ReviewSettings />);
    await ready();
    await user.click(screen.getByRole('combobox', { name: 'Group that checks Page 1' }));
    await user.click(await screen.findByRole('option', { name: 'Finance' }));
    await user.click(screen.getByRole('button', { name: 'Save review settings' }));
    expect(await screen.findByText('The server did not accept these settings: body/units/0/groupId: no such review group in this org, or it is archived')).toBeInTheDocument();
  });

  it('says so when this member cannot read the review groups', async () => {
    open({ ...twoPages(), review: { units: UNITS } });
    fakeApi({ groupsForbidden: true });
    render(<ReviewSettings />);
    await ready();
    expect(screen.getByText('You cannot see the review groups, so you cannot give a unit to one.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Group that checks Page 1' })).toBeDisabled();
  });

  it('points to the Members page when the org has no review group yet', async () => {
    open({ ...twoPages(), review: { units: UNITS } });
    fakeApi({ groups: [] });
    render(<ReviewSettings />);
    await ready();
    expect(screen.getByRole('link', { name: 'Open the Members page' })).toHaveAttribute('href', '/org/members');
  });
});
