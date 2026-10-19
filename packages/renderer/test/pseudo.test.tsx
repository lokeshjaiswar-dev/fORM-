// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PSEUDO_CLOSE, PSEUDO_LOCALE, PSEUDO_OPEN, findUnwrappedText } from '@form/i18n';
import type { FormDefinition, Locale } from '@form/schema';
import { FormRenderer } from '../src/index.ts';
import { kitchenSink, props, rich, runtime } from './build.ts';

/*
 * BL-010 (deferred from WP-0.12): under the en-XA pseudo-locale every string the renderer itself shows comes from a
 * catalogue, so it is wrapped in ⟦ ⟧. Author content is wrapped here first, so any letter left outside the brackets
 * in the rendered tree (text, aria-label, placeholder, title) is renderer text that bypassed the catalogue.
 */

const wrap = (s: string) => (s.trim() ? `${PSEUDO_OPEN}${s}${PSEUDO_CLOSE}` : s);
const TEXT_KEYS = new Set(['title', 'placeholder', 'prefix', 'suffix', 'lowLabel', 'highLabel', 'midLabel', 'startLabel', 'nextLabel', 'backLabel', 'label']);
const SKIP_KEYS = new Set(['privacy', 'i18n', 'logic', 'theme']);

/** Author text of a definition wrapped as if it had been translated through the catalogue. */
function pseudoContent<T>(value: T, key = ''): T {
  if (typeof value === 'string') return (TEXT_KEYS.has(key) ? wrap(value) : value) as T;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' && TEXT_KEYS.has(key) ? wrap(v) : pseudoContent(v, ''))) as T;
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record['type'] === 'text' && typeof record['text'] === 'string') return { ...record, text: wrap(record['text']) } as T;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, SKIP_KEYS.has(k) ? v : pseudoContent(v, k)])) as T;
}

/** Visible text plus the attributes assistive technology reads, outside the author's wrapped content. */
function unwrapped(root: Element): string[] {
  const attributes = [...root.querySelectorAll('[aria-label], [placeholder], [title], [alt]')].flatMap((el) =>
    ['aria-label', 'placeholder', 'title', 'alt'].map((name) => el.getAttribute(name) ?? '').filter(Boolean));
  return [...findUnwrappedText(root.textContent ?? ''), ...attributes.flatMap((a) => findUnwrappedText(a))];
}

const XA = PSEUDO_LOCALE as Locale;
const sink = (): FormDefinition => pseudoContent(kitchenSink());

describe(`renderer text under ${PSEUDO_LOCALE}`, () => {
  it('the check sees renderer text that is not pseudo-localised (sensitivity)', () => {
    const { container } = render(<FormRenderer {...props(runtime(sink()))} />);
    expect(unwrapped(container).join(' | ')).toMatch(/\(required\).*Next/s);
    const plain = render(<FormRenderer {...props(runtime(kitchenSink()), { locale: XA })} />);
    expect(unwrapped(plain.container).join(' | ')).toContain('short_text question');
  });

  it('every page, error and the ending show only catalogue text around author content', async () => {
    const { container } = render(<FormRenderer {...props(runtime(sink()), { locale: XA })} />);
    const user = userEvent.setup();
    const next = () => container.querySelector<HTMLButtonElement>('button[type="submit"]') as HTMLButtonElement;
    expect(unwrapped(container)).toEqual([]);

    await user.click(next());
    expect((await screen.findAllByText(/⟦Ţĥíš ƒíéļď íš ŕéǫúíŕéď/)).length).toBeGreaterThan(0);
    expect(unwrapped(container)).toEqual([]);

    await user.click(container.querySelector('.fr-disclosure-toggle') as HTMLButtonElement);
    await user.type(screen.getByRole('textbox', { name: /short_text question/ }), 'Asha');
    await user.type(screen.getByRole('textbox', { name: /email question/ }), 'asha@example.in');
    expect(unwrapped(container)).toEqual([]);
    await user.click(next());
    const rating = await screen.findByRole('radiogroup', { name: /rating question/ });
    await user.click(container.querySelector('.fr-signature-field .fr-link-button') as HTMLButtonElement);
    expect(unwrapped(container)).toEqual([]);

    await user.click(rating.querySelectorAll<HTMLButtonElement>('[role="radio"]')[3] as HTMLButtonElement);
    await user.click(next());
    await screen.findByRole('heading', { name: /Thanks for your response/ });
    expect(container.querySelector('.fr-ending')).not.toBeNull();
    expect(unwrapped(container)).toEqual([]);
  });

  it('status screens use the catalogue', () => {
    for (const state of ['closed', 'not_yet_open', 'limit_reached', 'already_submitted', 'password'] as const) {
      const status = state === 'not_yet_open' ? { state, opensAt: '2027-01-01T00:00:00Z' as never, screen: rich() } : { state, screen: rich() };
      const view = render(<FormRenderer {...props(runtime(sink(), status), { locale: XA })} />);
      expect(unwrapped(view.container)).toEqual([]);
      view.unmount();
    }
  });
});
