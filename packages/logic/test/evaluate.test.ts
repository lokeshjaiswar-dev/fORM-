import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { createEvaluator, evalStateJson, evaluate } from '../src/index.ts';
import {
  META, a, all, ans, any, bid, bool, choices, cond, date, disable, enable, expr, field, form, heading, hide, id, meta, nil, num, opts, page, pid,
  requireIt, rule, show, text, time, unrequire, versionOf,
} from './build.ts';

const sorted = (set: ReadonlySet<string>) => [...set].sort();

/* p1: name, colour, age · p2: intro, pets, visit, slot · p3: notes */
const blocks = () => [
  field('short_text', 'name'),
  field('single_choice', 'colour', { config: { display: 'radio', options: choices('red', 'blue'), other: { enabled: true, textRequired: false } } }),
  field('number', 'age'),
  heading('intro'),
  field('multi_choice', 'pets', { config: { display: 'checkbox', options: choices('cat', 'dog', 'fish') } }),
  field('date', 'visit'),
  field('time', 'slot'),
  field('long_text', 'notes'),
];
const pages = (extra: Partial<S.Page> = {}) => [page('p1', ['name', 'colour', 'age']), page('p2', ['intro', 'pets', 'visit', 'slot'], extra), page('p3', ['notes'])];

function run(rules: S.Rule[], answers: S.Answers, opts: { meta?: Partial<S.EvalMeta>; patch?: (def: S.FormDefinition) => void; pageExtra?: Partial<S.Page> } = {}) {
  const def = form(blocks(), pages(opts.pageExtra), rules);
  opts.patch?.(def);
  return evaluate(versionOf(def), answers, { ...META, ...opts.meta }, 'client');
}

/** Whether `rule` (show `notes` when `when`) fires for these answers. */
function fires(when: S.Condition | S.ConditionGroup, answers: S.Answers, extra: Parameters<typeof run>[2] = {}): boolean {
  const state = run([rule('r', when, [hide('notes')])], answers, extra);
  return !state.visible.has(bid('notes'));
}

describe('evaluate', () => {
  it('starts from the authored state and applies then / else', () => {
    const rules = [
      rule('r1', cond(ans('colour'), 'eq', opts('colour', 'blue')), [show('pets')], [requireIt('visit')]),
      rule('r2', cond(ans('age'), 'gte', num('18')), [disable('slot')], [unrequire('name')]),
    ];
    const patch = (def: S.FormDefinition) => {
      def.blocks[bid('pets')] = { ...(def.blocks[bid('pets')] as S.FieldBlockOf<'multi_choice'>), initiallyHidden: true };
      def.blocks[bid('name')] = { ...(def.blocks[bid('name')] as S.FieldBlockOf<'short_text'>), required: true };
    };
    const blue = run(rules, { [bid('colour')]: a.single('blue'), [bid('age')]: a.number('21'), [bid('slot')]: a.time('10:00') }, { patch });
    expect(blue.visible.has(bid('pets'))).toBe(true);
    expect(sorted(blue.required)).toEqual(['name']);
    expect(sorted(blue.disabled)).toEqual(['slot']);
    expect(Object.keys(blue.values).sort()).toEqual(['age', 'colour']);

    const red = run(rules, { [bid('colour')]: a.single('red'), [bid('age')]: a.number('7') }, { patch });
    expect(red.visible.has(bid('pets'))).toBe(false);
    expect(sorted(red.required)).toEqual(['visit']);
    expect(sorted(red.disabled)).toEqual([]);
  });

  it('a rule without else writes nothing when false', () => {
    const state = run([rule('r', cond(ans('age'), 'gt', num('5')), [hide('name')])], {});
    expect(state.visible.has(bid('name'))).toBe(true);
  });

  it('last write wins in authored order', () => {
    const state = run([
      rule('r1', cond(ans('age'), 'is_answered'), [hide('notes')]),
      rule('r2', cond(ans('age'), 'is_answered'), [show('notes')]),
      rule('r3', cond(ans('age'), 'gt', num('100')), [hide('notes')]),
    ], { [bid('age')]: a.number('3') });
    expect(state.visible.has(bid('notes'))).toBe(true);
    expect(run([rule('r', cond(ans('age'), 'is_answered'), [show('notes'), hide('notes')])], { [bid('age')]: a.number('3') }).visible.has(bid('notes'))).toBe(false);
  });

  it('hidden is transitive: a hidden source reads as unanswered (LOG-09)', () => {
    const rules = [
      rule('hide_name', cond(ans('age'), 'is_answered'), [hide('name')]),
      rule('show_notes', cond(ans('name'), 'is_answered'), [hide('notes')]),
    ];
    const both = run(rules, { [bid('age')]: a.number('3'), [bid('name')]: a.text('Asha') });
    expect(both.visible.has(bid('name'))).toBe(false);
    expect(both.visible.has(bid('notes'))).toBe(true);
    expect(both.values[bid('name')]).toBeUndefined();
    const nameOnly = run(rules, { [bid('name')]: a.text('Asha') });
    expect(nameOnly.visible.has(bid('notes'))).toBe(false);
  });

  it('hiding a page takes it off the path, with its blocks and answers', () => {
    const state = run([rule('r', cond(ans('age'), 'lt', num('18')), [hide('p2')])], { [bid('age')]: a.number('12'), [bid('visit')]: a.date('2026-11-01') });
    expect(state.path).toEqual(['p1', 'p3']);
    expect(state.visible.has(pid('p2'))).toBe(false);
    expect(state.visible.has(bid('visit'))).toBe(false);
    expect(state.values[bid('visit')]).toBeUndefined();
    expect(state.nextPage(pid('p1'))).toBe('p3');
    expect(state.nextPage(pid('p3'))).toEqual({ end: 'ending_1' });
    expect(state.endingId).toBe('ending_1');
  });

  it('a page that starts hidden is skipped until a rule shows it', () => {
    const rules = [rule('r', cond(ans('age'), 'gte', num('18')), [show('p2')])];
    expect(run(rules, {}, { pageExtra: { initiallyHidden: true } }).path).toEqual(['p1', 'p3']);
    expect(run(rules, { [bid('age')]: a.number('18') }, { pageExtra: { initiallyHidden: true } }).path).toEqual(['p1', 'p2', 'p3']);
  });

  it('required_eff needs visible, enabled and (for read-only fields) a value', () => {
    const patch = (def: S.FormDefinition) => {
      def.blocks[bid('name')] = { ...(def.blocks[bid('name')] as S.FieldBlockOf<'short_text'>), required: true, readOnly: true };
      def.blocks[bid('notes')] = { ...(def.blocks[bid('notes')] as S.FieldBlockOf<'long_text'>), required: true, initiallyDisabled: true };
      def.blocks[bid('age')] = { ...(def.blocks[bid('age')] as S.FieldBlockOf<'number'>), required: true };
    };
    const rules = [rule('r', cond(ans('colour'), 'eq', opts('colour', 'red')), [enable('notes'), hide('age')])];
    expect(sorted(run(rules, {}, { patch }).required)).toEqual(['age']);
    expect(sorted(run(rules, { [bid('name')]: a.text('x'), [bid('colour')]: a.single('red') }, { patch }).required)).toEqual(['name', 'notes']);
  });

  it('B21: a rule reading a deleted block is left out, so its targets keep their initial state (no plan step, no trace row)', () => {
    const rules = [
      rule('gone_hide', cond(ans('deleted'), 'is_not_answered'), [hide('notes')]),
      rule('gone_show', cond(ans('deleted'), 'eq', text('x')), [show('pets')], [hide('pets')]),
      rule('ok', cond(ans('age'), 'is_answered'), [hide('slot')]),
    ];
    const def = form(blocks(), pages(), rules);
    def.blocks[bid('pets')] = { ...(def.blocks[bid('pets')] as S.FieldBlockOf<'multi_choice'>), initiallyHidden: true };
    const version = versionOf(def);
    expect(version.compiled.plan.flatMap((s) => (s.kind === 'rule' ? [s.ruleId] : []))).toEqual(['ok']);
    for (const answers of [{}, { [bid('age')]: a.number('3') }]) {
      const state = evaluate(version, answers, META, 'client', { trace: true });
      expect(state.visible.has(bid('notes'))).toBe(true);
      expect(state.visible.has(bid('pets'))).toBe(false);
      expect(state.trace?.flatMap((row) => (row.step.kind === 'rule' ? [row.step.ruleId] : []))).toEqual(['ok']);
    }
  });

  it('drops answers of unknown blocks and of the wrong shape, with a diagnostic in the trace', () => {
    const def = form(blocks(), pages(), [rule('r', cond(ans('age'), 'gt', num('1')), [hide('notes')])]);
    const answers = { [bid('age')]: a.text('5'), [bid('ghost')]: a.text('x'), [bid('name')]: { type: 'short_text', value: '' } } as S.Answers;
    const state = evaluate(versionOf(def), answers, META, 'client', { trace: true });
    expect(state.values).toEqual({});
    expect(state.visible.has(bid('notes'))).toBe(true);
    expect(state.trace?.at(-1)).toEqual({
      step: { kind: 'rule', ruleId: 'r', scope: 'client+server' },
      fired: false,
      diagnostics: ["the answer for 'age' is not a valid number answer and reads as unanswered"],
    });
    expect(state.trace?.[0]).toEqual({ step: { kind: 'on_path', pageId: 'p1' }, fired: null });
  });

  it('captures hidden values from the URL, UTM tags, static text and expressions', () => {
    const def = form([
      field('short_text', 'name'),
      field('hidden', 'src', { config: { source: { kind: 'url_param', name: 'src' } } }),
      field('hidden', 'campaign', { config: { source: { kind: 'utm', param: 'campaign' } } }),
      field('hidden', 'fixed', { config: { source: { kind: 'static', value: ['v', '1'] } } }),
      field('hidden', 'copy', { config: { source: { kind: 'expr', expr: { k: 'ref', ref: { kind: 'answer', blockId: bid('name') } } } } }),
      field('long_text', 'notes'),
    ], [page('p1', ['name', 'src', 'campaign', 'fixed', 'copy', 'notes'])], [rule('r', cond(ans('copy'), 'eq', text('ASHA')), [hide('notes')])]);
    const state = evaluate(versionOf(def), { [bid('name')]: a.text('Asha'), [bid('src')]: a.hidden('stale') }, { ...META, urlParams: { src: 'ad', utm_campaign: 'diwali' } }, 'client');
    expect(state.values).toEqual({
      [bid('name')]: a.text('Asha'),
      [bid('src')]: a.hidden('ad'),
      [bid('campaign')]: a.hidden('diwali'),
      [bid('fixed')]: a.hidden('v1'),
      [bid('copy')]: a.hidden('Asha'),
    });
    expect(state.visible.has(bid('notes'))).toBe(false);
    const resumed = evaluate(versionOf(def), { [bid('src')]: a.hidden('kept') }, META, 'client');
    expect(resumed.values[bid('src')]).toEqual(a.hidden('kept'));
    expect(resumed.values[bid('copy')]).toBeUndefined();
  });

  it('static and expr hidden values are recomputed: a submitted value never replaces them', () => {
    const def = form([
      field('short_text', 'gate'),
      field('short_text', 'name'),
      field('hidden', 'src', { config: { source: { kind: 'url_param', name: 'src' } } }),
      field('hidden', 'fixed', { config: { source: { kind: 'static', value: ['v1'] } } }),
      field('hidden', 'blank', { config: { source: { kind: 'static', value: [''] } } }),
      field('hidden', 'copy', { config: { source: { kind: 'expr', expr: { k: 'ref', ref: { kind: 'answer', blockId: bid('name') } } } } }),
    ], [page('p1', ['gate', 'name', 'src', 'fixed', 'blank', 'copy'])], [rule('r', cond(ans('gate'), 'eq', text('hide')), [hide('name')])]);
    const forged = { [bid('src')]: a.hidden('resumed'), [bid('fixed')]: a.hidden('forged'), [bid('blank')]: a.hidden('forged'), [bid('copy')]: a.hidden('forged') };
    const expected = { [bid('src')]: a.hidden('resumed'), [bid('fixed')]: a.hidden('v1') };
    expect(evaluate(versionOf(def), forged, META, 'server').values).toEqual(expected);
    /* The source is hidden, so the copy reads null (LOG-09) and the forged value is dropped too. */
    const hiddenSource = evaluate(versionOf(def), { ...forged, [bid('gate')]: a.text('hide'), [bid('name')]: a.text('Asha') }, META, 'server');
    expect(hiddenSource.values).toEqual({ ...expected, [bid('gate')]: a.text('hide') });
    const session = createEvaluator(versionOf(def), META, 'server');
    session.evaluate({ [bid('name')]: a.text('Asha') });
    expect(session.update(forged, [bid('name'), bid('src'), bid('fixed'), bid('blank'), bid('copy')]).values).toEqual(expected);
  });

  describe('operators', () => {
    it('text: NFC and case folding by default, exact when case-sensitive', () => {
      const name = (v: string) => ({ [bid('name')]: a.text(v) });
      expect(fires(cond(ans('name'), 'eq', text('STRASSE')), name('straße'))).toBe(false);
      expect(fires(cond(ans('name'), 'eq', text('ΣΊΣΥΦΟΣ')), name('σίσυφος'))).toBe(true);
      expect(fires(cond(ans('name'), 'eq', text('Café')), name('Café'))).toBe(true);
      expect(fires(cond(ans('name'), 'eq', text('café'), { caseSensitive: true }), name('Café'))).toBe(false);
      expect(fires(cond(ans('name'), 'contains', text('ELL')), name('Hello'))).toBe(true);
      expect(fires(cond(ans('name'), 'not_contains', text('ELL')), name('Hello'))).toBe(false);
      expect(fires(cond(ans('name'), 'starts_with', text('he')), name('Hello'))).toBe(true);
      expect(fires(cond(ans('name'), 'not_starts_with', text('he')), name('Hello'))).toBe(false);
      expect(fires(cond(ans('name'), 'ends_with', text('LO')), name('Hello'))).toBe(true);
      expect(fires(cond(ans('name'), 'not_ends_with', text('x')), name('Hello'))).toBe(true);
      expect(fires(cond(ans('name'), 'eq', text('ǅ')), name('ǆ'))).toBe(true);
      expect(fires(cond(ans('name'), 'eq', text('İ')), name('i'))).toBe(false);
    });

    it('unanswered: null is false except through the null-safe eq / neq and the negated operators', () => {
      expect(fires(cond(ans('name'), 'eq', text('x')), {})).toBe(false);
      expect(fires(cond(ans('name'), 'neq', text('x')), {})).toBe(true);
      expect(fires(cond(ans('name'), 'eq', nil()), {})).toBe(true);
      expect(fires(cond(ans('name'), 'contains', text('x')), {})).toBe(false);
      expect(fires(cond(ans('name'), 'not_contains', text('x')), {})).toBe(true);
      expect(fires(cond(ans('age'), 'gt', num('-1')), {})).toBe(false);
      expect(fires(cond(ans('age'), 'is_not_answered'), {})).toBe(true);
    });

    it('numbers compare as decimals, never as strings or floats', () => {
      const age = (v: string) => ({ [bid('age')]: a.number(v) });
      expect(fires(cond(ans('age'), 'gt', num('9')), age('10'))).toBe(true);
      expect(fires(cond(ans('age'), 'eq', num('0.3')), age('0.3'))).toBe(true);
      expect(fires(cond(ans('age'), 'gt', num('0.1')), age('0.1000000001'))).toBe(true);
      expect(fires(cond(ans('age'), 'eq', num('1')), age('1.0'))).toBe(true);
      expect(fires(cond(ans('age'), 'lte', num('-2')), age('-2'))).toBe(true);
      expect(fires(cond(ans('age'), 'between', num('1'), { right2: num('10') }), age('10'))).toBe(true);
      expect(fires(cond(ans('age'), 'between', num('1'), { right2: num('10') }), age('10.5'))).toBe(false);
    });

    it('dates and times order by their ISO form', () => {
      expect(fires(cond(ans('visit'), 'before', date('2026-11-01')), { [bid('visit')]: a.date('2026-10-31') })).toBe(true);
      expect(fires(cond(ans('visit'), 'on_or_after', date('2026-11-01')), { [bid('visit')]: a.date('2026-11-01') })).toBe(true);
      expect(fires(cond(ans('visit'), 'after', date('2026-11-01')), { [bid('visit')]: a.date('2026-11-01') })).toBe(false);
      expect(fires(cond(ans('visit'), 'eq', date('2026-11-01')), { [bid('visit')]: a.date('2026-11-01') })).toBe(true);
      expect(fires(cond(ans('slot'), 'on_or_before', time('09:30')), { [bid('slot')]: a.time('09:30') })).toBe(true);
      expect(fires(cond(ans('slot', 'end'), 'is_answered'), { [bid('slot')]: a.time('09:30') })).toBe(false);
    });

    it('choices compare option ids as sets; Other counts as answered', () => {
      const pets = (...ids: string[]) => ({ [bid('pets')]: a.multi(...ids) });
      expect(fires(cond(ans('pets'), 'eq', opts('pets', 'dog', 'cat')), pets('cat', 'dog'))).toBe(true);
      expect(fires(cond(ans('pets'), 'eq', opts('pets', 'cat')), pets('cat', 'dog'))).toBe(false);
      expect(fires(cond(ans('pets'), 'includes_any', opts('pets', 'fish', 'dog')), pets('cat', 'dog'))).toBe(true);
      expect(fires(cond(ans('pets'), 'includes_all', opts('pets', 'fish', 'dog')), pets('cat', 'dog'))).toBe(false);
      expect(fires(cond(ans('pets'), 'includes_none', opts('pets', 'fish')), pets('cat', 'dog'))).toBe(true);
      expect(fires(cond(ans('pets'), 'includes_none', opts('pets', 'fish')), {})).toBe(true);
      expect(fires(cond(ans('pets'), 'count_eq', num('2')), pets('cat', 'dog'))).toBe(true);
      expect(fires(cond(ans('pets'), 'count_lte', num('0')), {})).toBe(true);
      expect(fires(cond(ans('pets', 'count'), 'gte', num('2')), pets('cat', 'dog'))).toBe(true);
      expect(fires(cond(ans('colour'), 'eq', opts('colour', 'red')), { [bid('colour')]: a.single('red') })).toBe(true);
      expect(fires(cond(ans('colour'), 'neq', opts('colour', 'red')), { [bid('colour')]: a.single('blue') })).toBe(true);
      expect(fires(cond(ans('colour'), 'includes_any', opts('colour', 'red', 'blue')), { [bid('colour')]: a.single('blue') })).toBe(true);
      expect(fires(cond(ans('colour'), 'is_answered'), { [bid('colour')]: a.single(null, 'green') })).toBe(true);
      expect(fires(cond(ans('colour', 'other'), 'eq', text('GREEN')), { [bid('colour')]: a.single(null, 'green') })).toBe(true);
    });

    it('groups: all / any / negate; empty all is true, empty any is false', () => {
      const answers = { [bid('age')]: a.number('20'), [bid('name')]: a.text('x') };
      expect(fires(all(), {})).toBe(true);
      expect(fires(any(), {})).toBe(false);
      expect(fires(all(cond(ans('age'), 'gt', num('18')), cond(ans('name'), 'is_answered')), answers)).toBe(true);
      expect(fires(any(cond(ans('age'), 'lt', num('18')), cond(ans('name'), 'is_not_answered')), answers)).toBe(false);
      expect(fires({ ...any(cond(ans('age'), 'lt', num('18'))), negate: true }, answers)).toBe(true);
      expect(fires(all(any(cond(ans('age'), 'lt', num('18')), all(cond(ans('name'), 'eq', text('X')))), cond(ans('age'), 'is_answered')), answers)).toBe(true);
    });

    it('meta values and comparison expressions', () => {
      const m = { meta: { urlParams: { src: 'ad', utm_source: 'mail' }, device: 'mobile' as const, isPreview: true } };
      expect(fires(cond(meta('url_param', 'src'), 'eq', text('AD')), {}, m)).toBe(true);
      expect(fires(cond(meta('url_param', 'toString'), 'is_answered'), {}, m)).toBe(false);
      expect(fires(cond(meta('utm_source'), 'eq', text('mail')), {}, m)).toBe(true);
      expect(fires(cond(meta('device'), 'eq', text('mobile')), {}, m)).toBe(true);
      expect(fires(cond(meta('locale'), 'eq', text('en-in')), {}, m)).toBe(true);
      expect(fires(cond(meta('time_zone'), 'eq', text('Asia/Kolkata')), {}, m)).toBe(true);
      expect(fires(cond(meta('referrer'), 'is_answered'), {}, m)).toBe(false);
      expect(fires(cond(meta('is_preview'), 'is_true'), {}, m)).toBe(true);
      expect(fires(cond(meta('is_preview'), 'eq', bool(false)), {}, m)).toBe(false);
      const older = expr({ k: 'binary', op: '>', left: { k: 'ref', ref: { kind: 'answer', blockId: bid('age') } }, right: { k: 'lit', value: { type: 'number', value: id('17') } } });
      expect(fires(cond(older, 'is_true'), { [bid('age')]: a.number('18') })).toBe(true);
      expect(fires(cond(older, 'is_false'), {})).toBe(false);
      const same = expr({ k: 'binary', op: '==', left: { k: 'ref', ref: { kind: 'answer', blockId: bid('name') } }, right: { k: 'lit', value: { type: 'null' } } });
      expect(fires(cond(same, 'is_true'), {})).toBe(true);
    });
  });

  it('hides nothing on the client for server-only rules and reports no server effects', () => {
    const state = run([rule('r', cond(ans('age'), 'is_answered'), [hide('notes')])], { [bid('age')]: a.number('1') });
    expect(state.serverEffects).toEqual([]);
    expect(state.submitBlocks).toEqual([]);
    expect(state.hiddenOptions).toEqual({});
    expect(state.variables).toEqual({});
  });

  it('serialises canonically', () => {
    const def = form(blocks(), pages(), [rule('r', cond(ans('age'), 'gt', num('1')), [hide('notes')])]);
    const state = evaluate(versionOf(def), { [bid('age')]: a.number('5') }, META, 'client');
    expect(evalStateJson(state, def.pages.map((p) => p.id))).toBe(
      '{"disabled":[],"endingId":"ending_1","hiddenOptions":{},"next":{"p1":"p2","p2":"p3","p3":{"end":"ending_1"}},"path":["p1","p2","p3"],'
      + '"required":[],"serverEffects":[],"submitBlocks":[],"values":{"age":{"type":"number","value":"5"}},"variables":{},'
      + '"visible":["age","colour","intro","name","p1","p2","p3","pets","slot","visit"]}',
    );
  });

  it('updates trace diagnostics when an answer goes between absent and invalid', () => {
    const version = versionOf(form(blocks(), pages(), [rule('r', cond(ans('age'), 'gt', num('1')), [hide('notes')])]));
    const ids = version.definition.pages.map((p) => p.id);
    const session = createEvaluator(version, META, 'client', { trace: true });
    const full = (answers: S.Answers) => evalStateJson(evaluate(version, answers, META, 'client', { trace: true }), ids);
    session.evaluate({});
    const invalid = { [bid('age')]: a.text('5') } as unknown as S.Answers;
    const json = evalStateJson(session.update(invalid, [bid('age')]), ids);
    expect(json).toContain("the answer for 'age' is not a valid number answer");
    expect(json).toBe(full(invalid));
    expect(evalStateJson(session.update({}, [bid('age')]), ids)).toBe(full({}));
  });

  it('refuses a version compiled by another engine', () => {
    const version = versionOf(form(blocks(), pages()));
    expect(() => evaluate({ ...version, compiled: { ...version.compiled, engine: 'logic@1' as 'logic@2' } }, {}, META, 'client')).toThrow(/logic@1/);
  });
});
