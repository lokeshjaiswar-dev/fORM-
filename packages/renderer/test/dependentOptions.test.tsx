// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type * as S from '@form/schema';
import { FormRenderer } from '../src/index.ts';
import { field, form, id, inline, page, props, runtime } from './build.ts';

const option = (optionId: string, ...parents: string[]): S.ChoiceOption => ({
  id: id<S.OptionId>(optionId),
  label: optionId,
  ...(parents.length ? { parentOptionIds: parents.map((p) => id<S.OptionId>(p)) } : {}),
});

/* Country → State → District as radio questions, so every offered option is visible at once. */
function cascade(): S.FormDefinition {
  const country = field('single_choice', 'country', { label: inline('Country'), config: { display: 'radio', options: [option('India'), option('USA')] } });
  const state = field('single_choice', 'state', {
    label: inline('State'),
    config: { display: 'radio', dependsOn: id<S.BlockId>('country'), options: [option('Maharashtra', 'India'), option('Karnataka', 'India'), option('Texas', 'USA'), option('Not listed')] },
  });
  const district = field('single_choice', 'district', {
    label: inline('District'),
    config: { display: 'radio', dependsOn: id<S.BlockId>('state'), options: [option('Pune', 'Maharashtra'), option('Bengaluru', 'Karnataka'), option('Austin', 'Texas')] },
  });
  return form([country, state, district], [page('p1', ['country', 'state', 'district'])]);
}

const radios = (question: string) => within(screen.getByRole('radiogroup', { name: question })).queryAllByRole('radio').map((r) => r.getAttribute('value'));

describe('dependent (cascading) options', () => {
  it('waits for the parent, offers only its children, and clears answers the parent no longer allows', async () => {
    render(<FormRenderer {...props(runtime(cascade()))} />);
    const user = userEvent.setup();

    expect(screen.getByText('Choose Country first')).toBeInTheDocument();
    expect(screen.getByText('Choose State first')).toBeInTheDocument();
    expect(radios('State')).toEqual(['Not listed']);

    await user.click(screen.getByRole('radio', { name: 'India' }));
    expect(radios('State')).toEqual(['Maharashtra', 'Karnataka', 'Not listed']);
    expect(screen.queryByText('Choose Country first')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Maharashtra' }));
    expect(radios('District')).toEqual(['Pune']);
    await user.click(screen.getByRole('radio', { name: 'Pune' }));

    await user.click(screen.getByRole('radio', { name: 'USA' }));
    expect(radios('State')).toEqual(['Texas', 'Not listed']);
    expect(screen.getByRole('radio', { name: 'Texas' })).not.toBeChecked();
    expect(screen.getByText('Choose State first')).toBeInTheDocument();
    expect(radios('District')).toEqual([]);

    await user.click(screen.getByRole('radio', { name: 'Texas' }));
    expect(radios('District')).toEqual(['Austin']);
    expect(screen.getByRole('radio', { name: 'Austin' })).not.toBeChecked();
  });
});
