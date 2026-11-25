// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('phone country picker', () => {
  const def = form([field('phone', 'tel', { config: { defaultCountry: 'IN' as never, showCountrySelect: true } })], [page('p1', ['tel'])]);

  it('shows our own flag and +91, lists countries by name, and switches with the calling code', async () => {
    const submitted: SubmitPayload[] = [];
    const { container } = render(<FormRenderer {...props(runtime(def), { onSubmit: (p) => void submitted.push(p) })} />);
    const picker = screen.getByRole('combobox', { name: 'Country calling code' });
    expect(picker).toHaveValue('IN');
    expect(container.querySelector('.fr-phone-code')).toHaveTextContent('+91');
    expect(screen.getByRole('option', { name: 'India (+91)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'United States (+1)' })).toBeInTheDocument();
    /* No emoji flags anywhere: they show as letters on Windows. */
    expect(container.textContent).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
    await waitFor(() => expect(container.querySelector('.fr-flag img')?.getAttribute('src')).toMatch(/IN\.svg|^data:image\/svg\+xml/));

    fireEvent.change(picker, { target: { value: 'US' } });
    expect(container.querySelector('.fr-phone-code')).toHaveTextContent('+1');
    await waitFor(() => expect(container.querySelector('.fr-flag img')?.getAttribute('src')).toMatch(/US\.svg|^data:image\/svg\+xml/));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '2025550123' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Submit' }));
    expect(submitted[0]?.answers[id<BlockId>('tel')]).toEqual({ type: 'phone', value: { e164: '+12025550123', country: 'US' } });
  });

  it('every calling-code region has a flag file', async () => {
    const { CALLING_CODE_REGIONS } = await import('@form/registry');
    const { flagUrl } = await import('../src/controls/flags/index.ts');
    const missing: string[] = [];
    for (const region of CALLING_CODE_REGIONS) if (!(await flagUrl(region))) missing.push(region);
    expect(missing).toEqual([]);
  });
});
