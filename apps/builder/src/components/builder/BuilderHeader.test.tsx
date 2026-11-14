import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BuilderHeader } from '@/components/builder/BuilderHeader';
import { addBlock } from '@/state/actions';
import { undo, useHistoryShortcuts } from '@/state/history';
import { useUiStore } from '@/state/uiStore';
import { blockIds, resetStore } from '@/test/fixtures';
import { publishLive } from '@/persistence/publishApi';

vi.mock('@/persistence/publishApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/publishApi')>();
  return { ...actual, publishLive: vi.fn() };
});

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
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetStore();
  addBlock({ type: 'short_text', configOverrides: {} });
  undo();
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

  it('shows the save state and links back to the forms list', () => {
    renderHeader();
    act(() => useUiStore.setState({ save: { state: 'saving' } }));
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    fireEvent.click(screen.getByRole('link', { name: 'Forms' }));
    expect(screen.getByLabelText('path')).toHaveTextContent('/forms');
  });

  it('publishes and shows a share link anyone can open', async () => {
    vi.mocked(publishLive).mockResolvedValue({ slug: 'hello-form', versionId: 'v1', number: 1 });
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('dialog', { name: 'Share form' })).toBeInTheDocument();
    expect(screen.getByLabelText('Share link')).toHaveValue(`${window.location.origin}/f/hello-form`);
    expect(publishLive).toHaveBeenCalled();
  });

  it('copies the share link with the clipboard API', async () => {
    vi.mocked(publishLive).mockResolvedValue({ slug: 'hello-form', versionId: 'v1', number: 1 });
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
    vi.mocked(publishLive).mockResolvedValue({ slug: 'hello-form', versionId: 'v1', number: 1 });
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
