import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { createEvaluator, evaluate } from '../src/index.ts';
import { META, a, ans, bid, choices, cond, field, form, hide, oid, opts, page, rule, versionOf } from './build.ts';

const linked = (option: string, ...parents: string[]): S.ChoiceOption => ({ id: oid(option), label: option, parentOptionIds: parents.map(oid) });

/* Country → State → District, each a required dropdown; "other_state" is linked to no country, so it is always offered. */
const blocks = () => [
  field('single_choice', 'country', { required: true, config: { display: 'dropdown', options: choices('india', 'usa', 'china') } }),
  field('single_choice', 'state', {
    required: true,
    config: {
      display: 'dropdown',
      dependsOn: bid('country'),
      options: [linked('maharashtra', 'india'), linked('karnataka', 'india'), linked('california', 'usa'), linked('texas', 'usa'), linked('guangdong', 'china'), ...choices('other_state')],
    },
  }),
  field('single_choice', 'district', {
    required: true,
    config: { display: 'dropdown', dependsOn: bid('state'), options: [linked('pune', 'maharashtra'), linked('mumbai', 'maharashtra'), linked('bengaluru', 'karnataka'), linked('la', 'california')] },
  }),
];

function run(answers: S.Answers, patch?: (def: S.FormDefinition) => void, rules: S.Rule[] = []) {
  const def = form(blocks(), [page('p1', ['country', 'state', 'district'])], rules);
  patch?.(def);
  return evaluate(versionOf(def), answers, META, 'client');
}

const hidden = (state: S.EvalState, blockId: string) => [...(state.hiddenOptions[bid(blockId)] ?? [])].sort();

describe('dependent options', () => {
  it('before the country is chosen, State and District wait: disabled, not required, every linked option hidden', () => {
    const state = run({});
    expect([...state.disabled].sort()).toEqual(['district', 'state']);
    expect([...state.required]).toEqual(['country']);
    expect(hidden(state, 'state')).toEqual(['california', 'guangdong', 'karnataka', 'maharashtra', 'texas']);
    expect(hidden(state, 'country')).toEqual([]);
  });

  it('India offers only Indian states (and the unlinked option); USA offers only US states', () => {
    const india = run({ [bid('country')]: a.single('india') });
    expect(hidden(india, 'state')).toEqual(['california', 'guangdong', 'texas']);
    expect(india.disabled.has(bid('state'))).toBe(false);
    expect(india.required.has(bid('state'))).toBe(true);
    expect(india.disabled.has(bid('district'))).toBe(true);

    const usa = run({ [bid('country')]: a.single('usa') });
    expect(hidden(usa, 'state')).toEqual(['guangdong', 'karnataka', 'maharashtra']);
  });

  it('a chosen state offers only its districts', () => {
    const state = run({ [bid('country')]: a.single('india'), [bid('state')]: a.single('maharashtra') });
    expect(hidden(state, 'district')).toEqual(['bengaluru', 'la']);
    expect(state.disabled.has(bid('district'))).toBe(false);
  });

  it('when the country changes, a state that no longer fits does not unlock District', () => {
    const state = run({ [bid('country')]: a.single('usa'), [bid('state')]: a.single('maharashtra'), [bid('district')]: a.single('pune') });
    expect(hidden(state, 'state')).toContain('maharashtra');
    expect(state.disabled.has(bid('district'))).toBe(true);
    expect(state.values[bid('district')]).toBeUndefined();
  });

  it('a parent hidden by logic leaves its dependants waiting', () => {
    const state = run({ [bid('country')]: a.single('india') }, (def) => {
      def.blocks[bid('country')] = { ...(def.blocks[bid('country')] as S.FieldBlockOf<'single_choice'>), initiallyHidden: true };
    });
    expect(state.disabled.has(bid('state'))).toBe(true);
  });

  it('a rule reading State never sees a state the country no longer allows, on a full or an incremental pass', () => {
    /* Hide District while State is Maharashtra: a stale Maharashtra under USA must not keep it hidden. */
    const rules = [rule('r', cond(ans('state'), 'eq', opts('state', 'maharashtra')), [hide('district')])];
    const india = { [bid('country')]: a.single('india'), [bid('state')]: a.single('maharashtra') };
    const usa = { ...india, [bid('country')]: a.single('usa') };
    expect(run(india, undefined, rules).visible.has(bid('district'))).toBe(false);
    const full = run(usa, undefined, rules);
    expect(full.visible.has(bid('district'))).toBe(true);
    expect(full.values[bid('state')]).toBeUndefined();

    const def = form(blocks(), [page('p1', ['country', 'state', 'district'])], rules);
    const evaluator = createEvaluator(versionOf(def), META, 'client');
    evaluator.evaluate(india);
    const incremental = evaluator.update(usa, [bid('country')]);
    expect(incremental.visible.has(bid('district'))).toBe(true);
    expect(incremental.values[bid('state')]).toBeUndefined();
  });

  it('a parent answered with only "Other" unlocks the child with just its unlinked options', () => {
    const def = (d: S.FormDefinition) => {
      const country = d.blocks[bid('country')] as S.FieldBlockOf<'single_choice'>;
      d.blocks[bid('country')] = { ...country, config: { ...country.config, other: { enabled: true, textRequired: false } } };
    };
    const state = run({ [bid('country')]: a.single(null, 'Japan') }, def);
    expect(state.disabled.has(bid('state'))).toBe(false);
    expect(hidden(state, 'state')).toEqual(['california', 'guangdong', 'karnataka', 'maharashtra', 'texas']);
  });
});
