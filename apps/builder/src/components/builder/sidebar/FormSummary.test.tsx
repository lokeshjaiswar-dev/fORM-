import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { BlockId } from '@form/schema';
import { FormSummary } from '@/components/builder/sidebar/FormSummary';
import { filterSummary, summaryCounts, summaryItems } from '@/components/builder/sidebar/summaryItems';
import { useUiStore } from '@/state/uiStore';
import { block, doc, formWith, resetStore } from '@/test/fixtures';

const name = () => block('short_text', 'name', { label: 'Full name', required: true });
const email = () => block('email', 'email', { label: 'Work email', concealed: true });
const phone = () => block('phone', 'phone', { label: 'Phone', readOnly: true });
const heading = () => block('heading', 'intro', { config: { text: [{ type: 'text', text: 'About you' }] } });

describe('summaryItems', () => {
  it('lists blocks in form order with their required, hidden and read-only state', () => {
    const items = summaryItems(formWith([name(), email(), phone()]));
    expect(items.map((i) => (i.kind === 'block' ? [i.label, i.required, i.hidden, i.readOnly] : i.kind))).toEqual([
      ['Full name', true, false, false],
      ['Work email', false, true, false],
      ['Phone', false, false, true],
    ]);
  });

  it('marks where each page starts only when the form has several pages', () => {
    expect(summaryItems(formWith([name()])).some((i) => i.kind === 'page')).toBe(false);
    const items = summaryItems(formWith([[name()], [phone()]]));
    expect(items.map((i) => (i.kind === 'page' ? `page ${i.number}` : i.label))).toEqual(['page 1', 'Full name', 'page 2', 'Phone']);
  });

  it('counts blocks and filters by label or type', () => {
    const items = summaryItems(formWith([name(), email(), phone(), heading()]));
    expect(summaryCounts(items)).toEqual({ blocks: 4, required: 1, hidden: 1, readOnly: 1 });
    expect(filterSummary(items, 'mail').map((i) => i.kind === 'block' && i.label)).toEqual(['Work email']);
    expect(filterSummary(items, '  ')).toHaveLength(4);
  });

  it('never marks a heading as a field', () => {
    const [item] = summaryItems(formWith([heading()]));
    expect(item).toMatchObject({ kind: 'block', field: false, required: false, hidden: false });
  });
});

describe('FormSummary', () => {
  beforeEach(() => resetStore([name(), email(), phone()]));

  it('shows the form in one line and marks required and read-only fields', () => {
    render(<FormSummary query="" onAddFields={() => {}} />);
    expect(screen.getByText('3 blocks · 1 required · 1 hidden · 1 read-only')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Form structure' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Full name', 'Work emailHidden', 'Phone']);
    expect(within(rows[0]!).getByRole('img', { name: 'Required' })).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('img', { name: 'Read-only' })).toBeInTheDocument();
  });

  it('hides and shows a field with the eye, as one undoable change to the document', () => {
    render(<FormSummary query="" onAddFields={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Full name' }));
    /* Hidden replaces required: a respondent cannot answer a field they cannot see. */
    expect(doc().blocks['name' as BlockId]).toMatchObject({ concealed: true, required: false });
    fireEvent.click(screen.getByRole('button', { name: 'Show Full name' }));
    expect(doc().blocks['name' as BlockId]).not.toHaveProperty('concealed', true);
  });

  it('keeps a primary key visible: its eye is off', () => {
    resetStore([block('short_text', 'code', { label: 'Code', primaryKey: true, required: true })]);
    render(<FormSummary query="" onAddFields={() => {}} />);
    expect(screen.getByRole('button', { name: 'Hide Code' })).toBeDisabled();
  });

  it('selects a block and opens its settings when its row is clicked', () => {
    render(<FormSummary query="" onAddFields={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
    expect(useUiStore.getState()).toMatchObject({ activeBlockId: 'phone', inspectorOpen: true });
  });

  it('turns reordering off while searching', () => {
    render(<FormSummary query="phone" onAddFields={() => {}} />);
    expect(screen.queryByRole('button', { name: /^Reorder/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Form structure' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('points to the Fields tab when the form is empty', () => {
    resetStore([]);
    let asked = false;
    render(<FormSummary query="" onAddFields={() => (asked = true)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse fields to add' }));
    expect(asked).toBe(true);
  });
});
