import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppRoutes } from '@/App';
import { DOCUMENT_FORMAT } from '@/persistence/DocumentRepository';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { newStoredForm } from '@/persistence/openForm';
import { MemoryRepository, block, formWith } from '@/test/fixtures';

const NOW = '2026-10-19T04:30:00.000Z';

function Where() {
  return <span aria-label="path">{useLocation().pathname}</span>;
}

function renderApp(repo: MemoryRepository, path: string) {
  return render(
    <RepositoryProvider repo={repo}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <Where />
      </MemoryRouter>
    </RepositoryProvider>,
  );
}

const path = () => screen.getByLabelText('path').textContent;

function stored(id: string, title: string) {
  return { ...newStoredForm(id, NOW), doc: { ...formWith([block('text', { id: 'q', label: 'Question' })]), id, title } };
}

describe('routes', () => {
  it('sends / to the forms list, and New form opens an empty form at its own id (B23)', async () => {
    const repo = new MemoryRepository();
    renderApp(repo, '/');
    expect(await screen.findByText(/No forms yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    expect(await screen.findByRole('button', { name: 'Press Enter to start building' })).toBeInTheDocument();
    const id = path()?.replace('/builder/', '') ?? '';
    expect(id).not.toBe('demo');
    expect(repo.records.get(id)).toMatchObject({ id, rev: 0, doc: { id, blocks: [] } });
  });

  it('lists saved forms and opens one', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Feedback'));
    renderApp(repo, '/forms');
    fireEvent.click(await screen.findByRole('link', { name: /Feedback/ }));
    expect(await screen.findByDisplayValue('Feedback')).toBeInTheDocument();
    expect(path()).toBe('/builder/f1');
  });

  it('reopening a form restores what was saved (reload)', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Before'));
    const first = renderApp(repo, '/builder/f1');
    const title = await screen.findByDisplayValue('Before');
    const user = userEvent.setup();
    await user.clear(title);
    await user.type(title, 'After');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    first.unmount();
    expect(repo.records.get('f1')).toMatchObject({ rev: expect.any(Number), doc: { title: 'After' } });

    renderApp(repo, '/builder/f1');
    expect(await screen.findByDisplayValue('After')).toBeInTheDocument();
  });

  it('the preview URL opens the preview, and Edit returns to the canvas', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Feedback'));
    renderApp(repo, '/builder/f1/preview');
    expect(await screen.findByRole('button', { name: 'Submit' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Feedback')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByDisplayValue('Feedback')).toBeInTheDocument();
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

  it('a v1 import opens as a new form and shows its notes', async () => {
    const repo = new MemoryRepository();
    renderApp(repo, '/forms');
    await screen.findByText(/No forms yet/);
    const v1 = { ...formWith([block('text', { id: 'name', label: 'Name' })]), title: 'Old form' };
    v1.settings = { ...v1.settings, redirectUrl: 'http://example.com' };
    const file = new File([JSON.stringify(v1)], 'old.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('v1 JSON file'), { target: { files: [file] } });
    expect(await screen.findByDisplayValue('Old form')).toBeInTheDocument();
    const notes = screen.getByRole('region', { name: 'Form notes' });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(notes).toHaveTextContent('the redirect URL is not https');
    const id = path()?.replace('/builder/', '') ?? '';
    expect(repo.records.get(id)).toMatchObject({ format: DOCUMENT_FORMAT, doc: { id, title: 'Old form' } });
  });

  it('a file that is not a v1 form is refused on the list', async () => {
    const repo = new MemoryRepository();
    renderApp(repo, '/forms');
    await screen.findByText(/No forms yet/);
    fireEvent.change(screen.getByLabelText('v1 JSON file'), { target: { files: [new File(['{"schemaVersion":2}'], 'new.json')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('not a v1 form');
    expect(path()).toBe('/forms');
  });

  it('says so when this browser cannot save a new form', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'save').mockRejectedValue(new Error('QuotaExceededError'));
    renderApp(repo, '/forms');
    await screen.findByText(/No forms yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved in this browser');
    expect(path()).toBe('/forms');
  });

  it('reopening a stored form shows what the v2 migration changes (load runs migrateV1ToV2)', async () => {
    const repo = new MemoryRepository();
    const form = stored('old', 'Old');
    await repo.save({ ...form, doc: { ...form.doc, settings: { ...form.doc.settings, redirectUrl: 'http://example.com' } } });
    renderApp(repo, '/builder/old');
    expect(await screen.findByDisplayValue('Old')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('region', { name: 'Form notes' })).toHaveTextContent('the redirect URL is not https');
  });
});
