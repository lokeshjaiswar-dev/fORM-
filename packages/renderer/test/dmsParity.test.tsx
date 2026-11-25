// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BlockId, ChoiceOption, OptionId } from '@form/schema';
import { formatDate, parseDate } from '../src/controls/dateFormat.ts';
import { SEARCH_FROM_OPTIONS } from '../src/controls/single_choice.tsx';
import { FormRenderer, type SubmitPayload } from '../src/index.ts';
import { field, form, id, page, props, runtime } from './build.ts';

/* What DMS users saw in the deployed embed (25 Nov 2026): dates in the browser's mm/dd/yyyy and a stray search box on every dropdown. */

const DMY = { order: ['D', 'M', 'Y'], separator: '-' } as const;
const MDY = { order: ['M', 'D', 'Y'], separator: '/' } as const;

describe('date pattern codec', () => {
  it('reads typed dates in the pattern order, with any separator, and ISO', () => {
    expect(parseDate('25-11-2026', DMY)).toBe('2026-11-25');
    expect(parseDate('5/1/2026', DMY)).toBe('2026-01-05');
    expect(parseDate('2026-11-25', DMY)).toBe('2026-11-25');
    expect(parseDate('11/25/2026', MDY)).toBe('2026-11-25');
  });

  it('refuses impossible and half-typed dates', () => {
    expect(parseDate('31-02-2026', DMY)).toBeUndefined();
    expect(parseDate('29-02-2027', DMY)).toBeUndefined();
    expect(parseDate('29-02-2028', DMY)).toBe('2028-02-29');
    expect(parseDate('25-11-26', DMY)).toBeUndefined();
    expect(parseDate('25-11', DMY)).toBeUndefined();
    expect(parseDate('aa-bb-cccc', DMY)).toBeUndefined();
    expect(parseDate('', DMY)).toBeUndefined();
  });

  it('formats ISO in the pattern', () => {
    expect(formatDate('2026-01-05' as never, DMY)).toBe('05-01-2026');
    expect(formatDate('2026-01-05' as never, MDY)).toBe('01/05/2026');
  });
});

describe('date field in the DMS pattern', () => {
  const def = form([field('date', 'day', { config: { pattern: 'DD-MM-YYYY', picker: 'calendar' } })], [page('p1', ['day'])]);

  it('shows DD-MM-YYYY, takes a typed date and submits ISO', async () => {
    const submitted: SubmitPayload[] = [];
    render(<FormRenderer {...props(runtime(def), { onSubmit: (p) => void submitted.push(p) })} />);
    const day = screen.getByLabelText(/day/);
    expect(day).toHaveAttribute('type', 'text');
    expect(day).toHaveAttribute('placeholder', 'DD-MM-YYYY');
    expect(screen.getByRole('button', { name: 'Open calendar' })).toBeInTheDocument();
    fireEvent.change(day, { target: { value: '25/11/2026' } });
    fireEvent.blur(day);
    expect(day).toHaveValue('25-11-2026');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Submit' }));
    expect(submitted[0]?.answers[id<BlockId>('day')]).toEqual({ type: 'date', value: '2026-11-25' });
  });

  it('keeps the browser date input when the block asks for the native picker', () => {
    const native = form([field('date', 'day', { config: { pattern: 'DD-MM-YYYY', picker: 'native' } })], [page('p1', ['day'])]);
    render(<FormRenderer {...props(runtime(native))} />);
    expect(screen.getByLabelText(/day/)).toHaveAttribute('type', 'date');
  });
});

describe('searchable dropdown', () => {
  const opts = (n: number): ChoiceOption[] => Array.from({ length: n }, (_, i) => ({ id: `o${i + 1}` as OptionId, label: `Option ${i + 1}` }) as unknown as ChoiceOption);
  const dropdown = (n: number) =>
    form([field('single_choice', 'pick', { config: { display: 'dropdown', searchable: true, options: opts(n) } })], [page('p1', ['pick'])]);

  it('is one select with a short list: no extra search box', () => {
    render(<FormRenderer {...props(runtime(dropdown(3)))} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it(`shows the search box from ${SEARCH_FROM_OPTIONS} options, labelled as a search`, () => {
    render(<FormRenderer {...props(runtime(dropdown(SEARCH_FROM_OPTIONS)))} />);
    expect(screen.getByRole('searchbox', { name: 'Search options…' })).toHaveAttribute('placeholder', 'Search options…');
  });
});
