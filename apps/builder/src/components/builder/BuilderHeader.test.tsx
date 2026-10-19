import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BuilderHeader } from '@/components/builder/BuilderHeader';
import { addBlock } from '@/state/actions';
import { undo, useHistoryShortcuts } from '@/state/history';
import { useUiStore } from '@/state/uiStore';
import { blockIds, resetStore } from '@/test/fixtures';

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
});
