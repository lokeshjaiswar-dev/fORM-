// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTION_NAV } from '@form/schema';
import { FormRenderer } from '../src/index.ts';
import { listFormSections, sectionIndexForPage } from '../src/sections.ts';
import { content, field, form, page, props, runtime } from './build.ts';

function sample() {
  const def = form(
    [
      content('section_break', 's_personal', { name: 'Personal information' }),
      field('short_text', 'name'),
      content('section_break', 's_edu', { name: 'Education' }),
      field('short_text', 'school'),
      content('section_break', 's_pay', { name: 'Payment' }),
      field('number', 'amount'),
    ],
    [page('p1', ['s_personal', 'name']), page('p2', ['s_edu', 'school']), page('p3', ['s_pay', 'amount'])],
  );
  return { ...def, behavior: { ...def.behavior, sectionNav: { ...DEFAULT_SECTION_NAV, currentMarker: 'pulse' as const, includeSubmit: true } } };
}

describe('section breaks', () => {
  it('lists named sections in document order', () => {
    const def = sample();
    expect(listFormSections(def).map((s) => s.name)).toEqual(['Personal information', 'Education', 'Payment']);
    expect(sectionIndexForPage(listFormSections(def), def.pages, def.pages[0]!.id)).toBe(0);
    expect(sectionIndexForPage(listFormSections(def), def.pages, def.pages[1]!.id)).toBe(1);
  });

  it('shows the navigator with the current section marked', async () => {
    render(<FormRenderer {...props(runtime(sample()))} />);
    const nav = screen.getByRole('navigation', { name: 'Form sections' });
    expect(nav).toBeInTheDocument();
    expect(nav.querySelector('[data-state="current"]')?.textContent).toMatch(/Personal information/);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /name/ }), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('textbox', { name: /school/ })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Form sections' }).querySelector('[data-state="current"]')?.textContent).toMatch(/Education/);
  });

  it('hides the navigator until section breaks are enabled', () => {
    const def = form(
      [content('section_break', 's_personal', { name: 'Personal information' }), field('short_text', 'name')],
      [page('p1', ['s_personal', 'name'])],
    );
    const { container } = render(<FormRenderer {...props(runtime(def))} />);
    expect(container.querySelector('.fr-section-nav')).toBeNull();
  });

  it('clicking a section in the navigator jumps to that page', async () => {
    render(<FormRenderer {...props(runtime(sample()))} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Education/ }));
    expect(await screen.findByRole('textbox', { name: /school/ })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Form sections' }).querySelector('[data-state="current"]')?.textContent).toMatch(/Education/);
  });

  it('places the navigator on the left with card chrome', () => {
    const def = {
      ...sample(),
      behavior: { ...sample().behavior, sectionNav: { ...DEFAULT_SECTION_NAV, placement: 'left' as const, chrome: 'cards' as const } },
    };
    const { container } = render(<FormRenderer {...props(runtime(def))} />);
    expect(container.querySelector('.fr-form-main')).toHaveAttribute('data-section-placement', 'left');
    expect(screen.getByRole('navigation', { name: 'Form sections' })).toHaveAttribute('data-chrome', 'cards');
    expect(container.querySelector('[data-marker="card"]')).toBeTruthy();
  });
});
