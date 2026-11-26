import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BuilderHeader } from '@/components/builder/BuilderHeader';
import { addBlock } from '@/state/actions';
import { undo, useHistoryShortcuts } from '@/state/history';
import { useUiStore } from '@/state/uiStore';
import { block, blockIds, doc, resetStore } from '@/test/fixtures';
import { flushAutosave } from '@/persistence/autosave';

const loadSession = vi.fn();
const orgCall = vi.fn();

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return { ...actual, loadSession: () => loadSession() };
});

vi.mock('@/persistence/draftsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/draftsApi')>();
  return { ...actual, orgCall: (...args: unknown[]) => orgCall(...args) };
});

vi.mock('@/persistence/autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/autosave')>();
  return { ...actual, flushAutosave: vi.fn().mockResolvedValue({ serverRev: 3 }) };
});

const ME = { user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false }, session: null, orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }], activeOrgId: 'o1' };
const reply = (status: number, json: unknown) => ({ status, ok: status >= 200 && status < 300, json });
const LIVE = { slug: 'hello-form', versionId: 'v1', number: 1, draftRev: 3 };
const CLEAN = { ok: true, draftRev: 3, definitionHash: 'h', issues: [], issueCount: 0 };

/** The API as the header meets it: `/validate` answers `check`, `/publish` answers `publish`. */
function api({ check = reply(200, CLEAN), publish = reply(200, LIVE) } = {}) {
  orgCall.mockImplementation((_org: string, _method: string, path: string) => Promise.resolve(path.endsWith('/validate') ? check : publish));
}
const published = () => orgCall.mock.calls.filter(([, , path]) => String(path).endsWith('/publish'));

function Where() {
  return <span aria-label="path">{useLocation().pathname}</span>;
}

function Shortcuts() {
  useHistoryShortcuts();
  return null;
}

function renderHeader(path = '/builder/f1') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/builder/:id/preview?" element={<><BuilderHeader /><Shortcuts /><input aria-label="field" /><Where /></>} />
        <Route path="/forms" element={<Where />} />
        <Route path="/auth/sign-in" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetStore();
  addBlock({ type: 'short_text', configOverrides: {} });
  undo();
  loadSession.mockReset().mockResolvedValue({ status: 'signed_in', me: ME });
  orgCall.mockReset();
  api();
  vi.mocked(flushAutosave).mockClear();
  sessionStorage.clear();
});

afterEach(() => vi.unstubAllGlobals());

describe('BuilderHeader', () => {
  it('redoes with Mod+Shift+Z outside text fields', () => {
    renderHeader();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(blockIds()).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(blockIds()).toHaveLength(0);
  });

  it('B22: does not undo or redo while typing in a field', () => {
    renderHeader();
    const input = screen.getByLabelText('field');
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(input, { key: 'y', ctrlKey: true });
    expect(blockIds()).toHaveLength(0);
  });

  it('enables Undo and Redo from the document history only', () => {
    renderHeader();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(blockIds()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(blockIds()).toHaveLength(0);
  });

  it('B23: Edit and Preview change the URL, and the URL decides which one is shown', () => {
    renderHeader('/builder/f1/preview');
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('path')).toHaveTextContent(/^\/builder\/f1$/);
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByLabelText('path')).toHaveTextContent('/builder/f1/preview');
  });

  it('links to the form’s settings: its emails, webhooks and email log (WP-1.16)', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/forms/f1/settings');
  });

  it('shows the save state and links back to the forms list', () => {
    renderHeader();
    act(() => useUiStore.setState({ save: { state: 'saving' } }));
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    fireEvent.click(screen.getByRole('link', { name: 'Back to forms' }));
    expect(screen.getByLabelText('path')).toHaveTextContent('/forms');
  });

  it('Settings opens form settings and Edit closes them, keeping the URL in edit mode', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Form settings' }));
    expect(useUiStore.getState().designOpen).toBe(true);
    expect(screen.getByRole('button', { name: 'Form settings' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(useUiStore.getState().designOpen).toBe(false);
    expect(screen.getByLabelText('path')).toHaveTextContent(/^\/builder\/f1$/);
  });

  it('Preview closes form settings and switches the URL to preview', () => {
    renderHeader();
    act(() => useUiStore.setState({ designOpen: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(useUiStore.getState().designOpen).toBe(false);
    expect(screen.getByLabelText('path')).toHaveTextContent('/builder/f1/preview');
  });

  it('renames the form from the top bar; Escape cancels and an empty name is ignored', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /^Rename form/ }));
    const input = screen.getByRole('textbox', { name: 'Form name' });
    fireEvent.change(input, { target: { value: '  Visitor log  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(doc().title).toBe('Visitor log');

    fireEvent.click(screen.getByRole('button', { name: /^Rename form/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Form name' }), { target: { value: 'Changed' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Form name' }), { key: 'Escape' });
    expect(doc().title).toBe('Visitor log');

    fireEvent.click(screen.getByRole('button', { name: /^Rename form/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Form name' }), { target: { value: '   ' } });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Form name' }));
    expect(doc().title).toBe('Visitor log');
  });

  it('Save As Draft writes the pending change now', async () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Save As Draft' }));
    expect(screen.getByRole('button', { name: 'Save As Draft' })).toBeDisabled();
    expect(flushAutosave).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save As Draft' })).toBeEnabled());
  });

  it('publishes and shows a share link anyone can open', async () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('dialog', { name: 'Share form' })).toBeInTheDocument();
    expect(screen.getByLabelText('Share link')).toHaveValue(`${window.location.origin}/f/hello-form`);
    expect(published()).toHaveLength(1);
    expect(published()[0]?.[3]).toMatchObject({ expectedDraftRev: 3, clientDefinitionHash: expect.any(String) });
  });

  it('sends someone who is not signed in to sign in, and brings them back to this form', async () => {
    loadSession.mockResolvedValue({ status: 'signed_out' });
    renderHeader('/builder/f1/preview');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(screen.getByLabelText('path')).toHaveTextContent('/auth/sign-in'));
    expect(screen.queryByRole('dialog', { name: 'Share form' })).not.toBeInTheDocument();
    expect(orgCall).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('fr.afterSignIn')).toBe('/builder/f1/preview');
    // The draft is saved first, so nothing is lost on the way.
    expect(flushAutosave).toHaveBeenCalled();
  });

  it('copies the share link with the clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { writeText }, platform: 'Linux x86_64' });
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('dialog', { name: 'Share form' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/f/hello-form`));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the share link selected, with a hint, when the clipboard API is blocked (http on a LAN IP)', async () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', { clipboard: undefined, platform: 'Linux x86_64' });
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('dialog', { name: 'Share form' })).toBeInTheDocument();
    const link = screen.getByLabelText('Share link') as HTMLInputElement;
    expect(link).toHaveAttribute('readonly');
    await waitFor(() => expect(link).toHaveFocus());
    expect(link.selectionEnd).toBe(link.value.length);
    expect(screen.getByText('Press Ctrl+C to copy the link.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

const ISSUES = [
  { severity: 'error', code: 'unsafe_regex', path: '/blocks/q/config/pattern', message: 'This pattern can hang the form.' },
  { severity: 'error', code: 'invalid_url_scheme', path: '/blocks/r/config/href', message: 'The URL must start with https:// or http://' },
  { severity: 'error', code: 'logic_cycle', path: '/logic/rules/r1', message: 'These rules depend on each other.' },
] as const;

describe('BuilderHeader publish issues (WP-1.07)', () => {
  beforeEach(() => {
    resetStore([block('short_text', 'q', { label: 'Question' }), block('short_text', 'r', { label: 'Website' })]);
  });

  const BLOCKED = { code: 'PUBLISH_BLOCKED', detail: 'This form has problems.', issueCount: 3, issues: ISSUES };

  it('lists the issues of a mocked 422, grouped by block, and "go to field" opens that block in the inspector', async () => {
    api({ publish: reply(422, BLOCKED) });
    renderHeader();
    act(() => useUiStore.getState().closeInspector());
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    const dialog = await screen.findByRole('dialog', { name: 'This form cannot be published yet' });
    expect(dialog).toHaveTextContent('3 problems need fixing');
    const question = within(dialog).getByRole('region', { name: 'Question' });
    expect(question).toHaveTextContent('unsafe_regex');
    expect(question).toHaveTextContent('This pattern can hang the form.');
    expect(within(dialog).getByRole('region', { name: 'Website' })).toHaveTextContent('invalid_url_scheme');
    expect(within(dialog).getByRole('region', { name: 'The form as a whole' })).toHaveTextContent('logic_cycle');
    // Only a block can be jumped to; the form-level cycle has no field to open.
    expect(within(dialog).getAllByRole('button', { name: /^Go to field/ })).toHaveLength(2);
    expect(screen.queryByRole('dialog', { name: 'Share form' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Go to field “Website”' }));
    expect(useUiStore.getState()).toMatchObject({ activeBlockId: 'r', inspectorOpen: true });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'This form cannot be published yet' })).not.toBeInTheDocument());
  });

  it('checks the saved draft with /validate first, and lists the issues without publishing anything', async () => {
    api({ check: reply(200, { ok: false, draftRev: 3, definitionHash: null, issueCount: 3, issues: ISSUES }) });
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'This form cannot be published yet' });
    expect(within(dialog).getByRole('region', { name: 'Question' })).toHaveTextContent('unsafe_regex');
    expect(orgCall).toHaveBeenCalledWith('o1', 'POST', '/v1/forms/f1/validate', {});
    expect(published()).toHaveLength(0);
    // A draft with an error cannot be published from the dialog: there is no "Publish anyway".
    expect(within(dialog).queryByRole('button', { name: 'Publish anyway' })).not.toBeInTheDocument();
    expect(flushAutosave).toHaveBeenCalled();
  });

  it('shows warnings first and publishes on confirmation', async () => {
    const warning = { severity: 'warning', code: 'missing_alt_text', path: '/blocks/q/config/alt', message: 'The picture has no description.' };
    api({ check: reply(200, { ok: true, draftRev: 3, definitionHash: 'h', issueCount: 1, issues: [warning] }) });
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish with warnings?' });
    expect(dialog).toHaveTextContent('missing_alt_text');
    expect(published()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish anyway' }));
    expect(await screen.findByRole('dialog', { name: 'Share form' })).toBeInTheDocument();
    expect(published()).toHaveLength(1);
  });

  it('says how many issues the server found beyond the ones it listed', async () => {
    api({ publish: reply(422, { ...BLOCKED, issueCount: 250 }) });
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'This form cannot be published yet' });
    expect(dialog).toHaveTextContent('247 more problems are not shown');
  });

  it('a plan mismatch is not an issue list: it asks for a reload', async () => {
    api({ publish: reply(422, { code: 'PLAN_MISMATCH', detail: 'The plan differs.' }) });
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/Reload the page, then publish again/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'This form cannot be published yet' })).not.toBeInTheDocument();
  });

  it('a 409 on publish opens no issue list: the merge dialog owns that answer', async () => {
    api({ publish: reply(409, { code: 'DRAFT_REV_CONFLICT' }) });
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(published()).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: 'This form cannot be published yet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Share form' })).not.toBeInTheDocument();
  });

  it('shows "Changed elsewhere" while a merge waits, and "Saved on this device" while offline', () => {
    renderHeader();
    act(() => useUiStore.setState({ save: { state: 'conflict' } }));
    expect(screen.getByRole('status')).toHaveTextContent('Changed elsewhere');
    act(() => useUiStore.setState({ save: { state: 'local', at: '2026-10-19T04:30:00.000Z' } }));
    expect(screen.getByRole('status')).toHaveTextContent('Saved on this device');
  });
});
