import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppRoutes } from '@/App';
import { DOCUMENT_FORMAT, LEGACY_FORMAT } from '@/persistence/DocumentRepository';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';
import { newStoredForm } from '@/persistence/openForm';
import { MemoryCustomFieldRepository, setCustomFieldRepository } from '@/fields/custom/repository';
import { MemoryRepository, MemorySubmissions, block, formWith, v1Form } from '@/test/fixtures';

const NOW = '2026-10-19T04:30:00.000Z';

function Where() {
  return <span aria-label="path">{useLocation().pathname}</span>;
}

function renderApp(repo: MemoryRepository, path: string, submissions = new MemorySubmissions()) {
  return render(
    <RepositoryProvider repo={repo}>
      <SubmissionsProvider repo={submissions}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <Where />
        </MemoryRouter>
      </SubmissionsProvider>
    </RepositoryProvider>,
  );
}

const path = () => screen.getByLabelText('path').textContent;

/** Opening the builder renders the whole canvas and editors; under parallel load that takes longer than findBy's 1 s default. */
const OPENS = { timeout: 15_000 };

function stored(id: string, title: string) {
  return newStoredForm(id, NOW, { ...formWith([block('short_text', 'q', { label: 'Question' })]), title });
}

describe('routes', () => {
  beforeEach(() => {
    setCustomFieldRepository(new MemoryCustomFieldRepository());
  });

  it('keeps /f/:slug as the public fill page', async () => {
    renderApp(new MemoryRepository(), '/f/hello');
    expect(await screen.findByText(/Form not found|This form cannot be opened|This link is not a published form/, {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/f/hello');
  });

  it('sends / to the forms list', async () => {
    renderApp(new MemoryRepository(), '/');
    expect(await screen.findByText(/No forms yet/, {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/forms');
  });

  it('sends /fields to the forms list', async () => {
    renderApp(new MemoryRepository(), '/fields');
    expect(await screen.findByText(/No forms yet/, {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/forms');
  });

  it('New form → Blank opens an empty v2 form at its own id (B23)', async () => {
    const repo = new MemoryRepository();
    renderApp(repo, '/forms');
    await screen.findByText(/No forms yet/, {}, OPENS);
    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    fireEvent.click(await screen.findByRole('button', { name: /Blank form/ }, OPENS));
    expect(await screen.findByRole('button', { name: 'Press Enter to start from scratch' }, OPENS)).toBeInTheDocument();
    const id = path()?.replace('/builder/', '') ?? '';
    expect(id).not.toBe('demo');
    expect(repo.records.get(id)).toMatchObject({ id, rev: 0, format: DOCUMENT_FORMAT, doc: { formId: id, schemaVersion: 2, blocks: {} } });
  });

  it('New form → a template instantiates it offline as a new v2 form', async () => {
    const repo = new MemoryRepository();
    renderApp(repo, '/forms');
    await screen.findByText(/No forms yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Contact us/ }, OPENS));
    fireEvent.click(screen.getByRole('button', { name: 'Use template' }));
    expect(await screen.findByDisplayValue('Contact us', {}, OPENS)).toBeInTheDocument();
    const id = path()?.replace('/builder/', '') ?? '';
    const record = repo.records.get(id);
    expect(record).toMatchObject({ format: DOCUMENT_FORMAT, doc: { formId: id, title: 'Contact us' } });
    expect(Object.keys((record?.doc as { blocks?: object } | undefined)?.blocks ?? {}).length).toBeGreaterThan(3);
  });

  it('opens responses for a form and shows filled data', async () => {
    const repo = new MemoryRepository();
    const submissions = new MemorySubmissions();
    await repo.save(stored('f1', 'Feedback'));
    await submissions.create({
      id: 's1',
      formId: 'f1',
      submittedAt: NOW,
      answers: { q: { type: 'short_text', value: 'Hello' } },
      fields: [{ key: 'q', label: 'Question', value: 'Hello' }],
    });
    renderApp(repo, '/forms', submissions);
    fireEvent.click(await screen.findByRole('link', { name: /Responses/ }));
    expect(path()).toBe('/forms/f1/responses');
    expect(await screen.findByText(/Submitted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View data' }));
    expect(await screen.findByRole('heading', { name: 'Submitted answers' })).toBeInTheDocument();
    expect(screen.getAllByText('Question').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Hello').length).toBeGreaterThan(0);
  });

  it('deletes a form from the list', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Feedback'));
    renderApp(repo, '/forms');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete form' }));
    expect(await screen.findByText(/No forms yet/)).toBeInTheDocument();
    expect(repo.records.has('f1')).toBe(false);
  });

  it('lists saved forms and opens one', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Feedback'));
    renderApp(repo, '/forms');
    fireEvent.click(await screen.findByRole('link', { name: /Feedback/ }));
    expect(await screen.findByDisplayValue('Feedback', {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/builder/f1');
  });

  it('reopening a form restores what was saved (reload)', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Before'));
    const first = renderApp(repo, '/builder/f1');
    const title = await screen.findByDisplayValue('Before', {}, OPENS);
    const user = userEvent.setup();
    await user.clear(title);
    await user.type(title, 'After');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    first.unmount();
    expect(repo.records.get('f1')).toMatchObject({ rev: expect.any(Number), doc: { title: 'After' } });

    renderApp(repo, '/builder/f1');
    expect(await screen.findByDisplayValue('After', {}, OPENS)).toBeInTheDocument();
  });

  it('the preview URL opens the preview, and Edit returns to the canvas', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Feedback'));
    renderApp(repo, '/builder/f1/preview');
    expect(await screen.findByRole('button', { name: 'Submit' }, OPENS)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Feedback')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByDisplayValue('Feedback', {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/builder/f1');
  });

  it('says so when the form does not exist or cannot be read', async () => {
    const repo = new MemoryRepository();
    renderApp(repo, '/builder/nope');
    expect(await screen.findByRole('heading', { name: 'Form not found' })).toBeInTheDocument();

    await repo.save({ id: 'odd', format: 'v9', rev: 1, savedAt: NOW, doc: {} });
    renderApp(repo, '/builder/odd');
    expect(await screen.findByRole('heading', { name: 'This form cannot be opened' })).toBeInTheDocument();
  });

  it('says so when this browser cannot save a new form', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'save').mockRejectedValue(new Error('QuotaExceededError'));
    renderApp(repo, '/forms');
    await screen.findByText(/No forms yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    fireEvent.click(await screen.findByRole('button', { name: /Blank form/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved in this browser');
    expect(path()).toBe('/forms');
  });

  it('merges two selected forms from the list', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('one', 'Alpha'));
    await repo.save(stored('two', 'Beta'));
    renderApp(repo, '/forms');
    expect(await screen.findByText('Alpha', {}, OPENS)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Beta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected' }));
    expect(await screen.findByDisplayValue('Alpha + Beta', {}, OPENS)).toBeInTheDocument();
    expect(path()?.startsWith('/builder/')).toBe(true);
  });

  it('asks which field to keep when merged validations clash', async () => {
    const repo = new MemoryRepository();
    await repo.save(newStoredForm('one', NOW, formWith([block('short_text', 'n1', { label: 'Code', config: { pattern: { source: '^[A-Z]+$' } } })])));
    await repo.save(newStoredForm('two', NOW, formWith([block('short_text', 'n2', { label: 'Code', config: { pattern: { source: '^[0-9]+$' } } })])));
    renderApp(repo, '/forms');
    expect(await screen.findAllByText('Test form', {}, OPENS)).toHaveLength(2);
    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected' }));
    expect(await screen.findByRole('heading', { name: 'These fields cannot be combined' }, OPENS)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Merge with these choices' }));
    expect(await screen.findByDisplayValue(/Test form/, {}, OPENS)).toBeInTheDocument();
  });

  it('BL-143: reopening a v1 draft migrates it once, saves it back as v2 and shows what changed', async () => {
    const repo = new MemoryRepository();
    await repo.save({ id: 'old', format: LEGACY_FORMAT, rev: 2, savedAt: NOW, doc: v1Form([{ id: 'q', type: 'text', label: 'Question' }], { redirectUrl: 'http://example.com', password: 'hunter2' }) });
    renderApp(repo, '/builder/old');
    expect(await screen.findByDisplayValue('Old form', {}, OPENS)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('region', { name: 'Form notes' })).toHaveTextContent('the redirect URL is not https');
    expect(repo.records.get('old')).toMatchObject({ format: DOCUMENT_FORMAT, rev: 3, doc: { formId: 'old', schemaVersion: 2 }, ops: { password: 'hunter2' } });
    expect(JSON.stringify(repo.records.get('old')?.doc)).not.toContain('hunter2');
  });
});
