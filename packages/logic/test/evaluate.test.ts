import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { createEvaluator, evalStateJson, evaluate } from '../src/index.ts';
import {
  META, a, all, ans, any, bid, bool, choices, cond, date, disable, enable, expr, field, form, heading, hide, id, meta, nil, num, oid, opts, page, pid,
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

  it('captures session details from the page, UTM tags, URL parameters and static values', () => {
    const def = form([
      field('context', 'session', {
        config: {
          sources: ['page_url', 'locale', 'utm_campaign'],
          urlParams: ['ref'],
          staticFacts: [{ key: 'channel', value: 'web' }],
        },
      }),
    ], [page('p1', ['session'])]);
    const state = evaluate(versionOf(def), {}, {
      ...META,
      pageUrl: 'https://example.test/form?ref=ad',
      urlParams: { ref: 'ad', utm_campaign: 'diwali' },
    }, 'client');
    expect(state.values[bid('session')]).toEqual({
      type: 'context',
      value: { page_url: 'https://example.test/form?ref=ad', locale: 'en-IN', utm_campaign: 'diwali', ref: 'ad', channel: 'web' },
    });
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

  it('a formula calculation multiplies number fields', () => {
    const def = form(
      [
        field('number', 'qty'),
        field('number', 'price'),
        field('calculation', 'total', {
          config: {
            expr: {
              k: 'binary',
              op: '*',
              left: { k: 'ref', ref: { kind: 'answer', blockId: bid('qty') } },
              right: { k: 'ref', ref: { kind: 'answer', blockId: bid('price') } },
            },
            resultType: 'number',
            display: 'visible',
          },
        }),
      ],
      [page('p1', ['qty', 'price', 'total'])],
    );
    const state = evaluate(versionOf(def), { [bid('qty')]: a.number('3'), [bid('price')]: a.number('4.5') }, META, 'client');
    expect(state.values[bid('total')]).toEqual({ type: 'calculation', value: { t: 'number', v: '13.5' } });
  });

  it('with skipHidden, leaves a hidden number out of a formula: addition skips it and multiplication does not zero out', () => {
    const ref = (name: string): S.Expr => ({ k: 'ref', ref: { kind: 'answer', blockId: bid(name) } });
    const total = (...parts: S.Expr[]): S.Expr => parts.slice(1).reduce<S.Expr>((left, right) => ({ k: 'binary', op: '+', left, right }), parts[0] as S.Expr);
    const product = (...parts: S.Expr[]): S.Expr => parts.slice(1).reduce<S.Expr>((left, right) => ({ k: 'binary', op: '*', left, right }), parts[0] as S.Expr);
    const calc = (id: string, expr: S.Expr) => field('calculation', id, { config: { expr, resultType: 'number', display: 'visible', skipHidden: true } });
    const def = form(
      [
        field('number', 'price'),
        field('number', 'igst'),
        field('number', 'cgst'),
        field('number', 'sgst'),
        field('number', 'rate'),
        field('number', 'factor'),
        calc('total', total(ref('price'), ref('igst'), ref('cgst'), ref('sgst'))),
        calc('gross', product(ref('price'), ref('rate'), ref('factor'))),
      ],
      [page('p1', ['price', 'igst', 'cgst', 'sgst', 'rate', 'factor', 'total', 'gross'])],
      [rule('tax', cond(ans('price'), 'is_answered'), [hide('cgst'), hide('sgst'), hide('factor')])],
    );
    const state = evaluate(versionOf(def), {
      [bid('price')]: a.number('100'),
      [bid('igst')]: a.number('18'),
      [bid('cgst')]: a.number('9'),
      [bid('sgst')]: a.number('9'),
      [bid('rate')]: a.number('2'),
      [bid('factor')]: a.number('5'),
    }, META, 'client');
    expect(state.visible.has(bid('cgst'))).toBe(false);
    expect(state.values[bid('total')]).toEqual({ type: 'calculation', value: { t: 'number', v: '118' } });
    expect(state.values[bid('gross')]).toEqual({ type: 'calculation', value: { t: 'number', v: '200' } });
  });

  describe('hidden operands keep their published meaning (review S2)', () => {
    const ref = (name: string): S.Expr => ({ k: 'ref', ref: { kind: 'answer', blockId: bid(name) } });
    const bin = (op: '+' | '-' | '*' | '/', left: S.Expr, right: S.Expr): S.Expr => ({ k: 'binary', op, left, right });
    const run = (skipHidden: boolean | undefined) => {
      const calc = (id: string, expr: S.Expr) => field('calculation', id, { config: { expr, resultType: 'number', display: 'visible', ...(skipHidden === undefined ? {} : { skipHidden }) } });
      const def = form(
        [field('number', 'amount'), field('number', 'qty'),
          calc('unit', bin('/', ref('amount'), ref('qty'))), calc('per', bin('/', ref('qty'), ref('amount'))),
          calc('diff', bin('-', ref('amount'), ref('qty'))), calc('times', bin('*', ref('amount'), ref('qty')))],
        [page('p1', ['amount', 'qty', 'unit', 'per', 'diff', 'times'])],
        [rule('r', cond(ans('qty'), 'is_answered'), [hide('amount')])],
      );
      const state = evaluate(versionOf(def), { [bid('amount')]: a.number('100'), [bid('qty')]: a.number('4') }, META, 'client');
      expect(state.visible.has(bid('amount'))).toBe(false);
      const num = (id: string) => (state.values[bid(id)] as { value?: { v?: string } } | undefined)?.value?.v ?? null;
      return { unit: num('unit'), per: num('per'), diff: num('diff'), times: num('times') };
    };

    it('without the opt-in a hidden operand reads null, so every formula over it is empty (as on dev)', () => {
      expect(run(undefined)).toEqual({ unit: null, per: null, diff: null, times: null });
      expect(run(false)).toEqual({ unit: null, per: null, diff: null, times: null });
    });

    it('with skipHidden, + and - read it as 0 and * as 1, but a division never replaces a hidden numerator or divisor', () => {
      expect(run(true)).toEqual({ unit: null, per: null, diff: '-4', times: '4' });
    });
  });

  it.each([
    ['the State answer (dev)', { kind: 'ref', ref: { kind: 'answer', blockId: bid('state') } }],
    ['option_code(State) (the rules panel)', { kind: 'expr', expr: { k: 'call', fn: 'option_code', args: [{ k: 'ref', ref: { kind: 'answer', blockId: bid('state') } }] } }],
  ] as Array<[string, S.Operand]>)('GSTIN not_starts_with %s: a state option with no code does not block submit (dev semantics, review S2)', (_name, right) => {
    const def = form([
      field('single_choice', 'state', { config: { display: 'dropdown', options: [{ id: oid('mh'), label: 'Maharashtra', code: '27' }, { id: oid('goa'), label: 'Goa' }] } }),
      field('short_text', 'gstin'),
    ], [page('p1', ['state', 'gstin'])], [
      rule('gst', { kind: 'group', id: 'g' as S.ConditionId, combinator: 'all', children: [
        { kind: 'condition', id: 'c1' as S.ConditionId, left: ans('gstin'), op: 'is_answered' },
        { kind: 'condition', id: 'c2' as S.ConditionId, left: ans('state'), op: 'is_answered' },
        { kind: 'condition', id: 'c3' as S.ConditionId, left: ans('gstin'), op: 'not_starts_with', right },
      ] }, [{ type: 'block_submit', anchorBlockId: bid('gstin'), message: 'GSTIN must start with the state code' } as S.ClientAction]),
    ]);
    const check = (state: string, gstin: string) => evaluate(versionOf(def), { [bid('state')]: a.single(state), [bid('gstin')]: a.text(gstin) }, META, 'client').submitBlocks.length;
    expect(check('mh', '29AAAAA0000A1Z5')).toBe(1);
    expect(check('mh', '27AAAAA0000A1Z5')).toBe(0);
    expect(check('goa', '30AAAAA0000A1Z5')).toBe(0);
  });

  it('a formula sums every row of a repeating-group number', () => {
    const def = form(
      [
        field('repeating_group', 'items', { config: { children: [bid('amount')], minRows: 0, maxRows: 10, initialRows: 1, layout: 'stacked' } }),
        field('number', 'amount'),
        field('calculation', 'total', {
          config: {
            expr: { k: 'call', fn: 'sum', args: [{ k: 'ref', ref: { kind: 'answer', blockId: bid('amount') } }] },
            resultType: 'number',
            display: 'visible',
          },
        }),
      ],
      [page('p1', ['items', 'total'])],
    );
    const rows = a.group([
      { rowId: 'row_1', values: { [bid('amount')]: a.number('10') } },
      { rowId: 'row_2', values: { [bid('amount')]: a.number('20') } },
      { rowId: 'row_3', values: {} },
    ]);
    const state = evaluate(versionOf(def), { [bid('items')]: rows }, META, 'client');
    expect(state.values[bid('total')]).toEqual({ type: 'calculation', value: { t: 'number', v: '30' } });
  });

  it('sums the option value filled into each row, and a row formula uses that row’s value', () => {
    const fill = rule('fill', cond(ans('item'), 'is_answered'), [{
      type: 'set_value',
      target: bid('price'),
      value: { k: 'call', fn: 'option_code', args: [{ k: 'ref', ref: { kind: 'answer', blockId: bid('item') } }] },
    }]);
    const perRow: S.Expr = {
      k: 'binary',
      op: '*',
      left: { k: 'ref', ref: { kind: 'answer', blockId: bid('qty'), row: 'current' } },
      right: { k: 'ref', ref: { kind: 'answer', blockId: bid('price'), row: 'current' } },
    };
    const def = form(
      [
        field('repeating_group', 'items', { config: { children: [bid('item'), bid('price'), bid('qty'), bid('line')], minRows: 0, maxRows: 10, initialRows: 1, layout: 'stacked' } }),
        field('single_choice', 'item', { config: { display: 'dropdown', options: [{ id: oid('burger'), label: 'Burger', code: '40' }, { id: oid('fries'), label: 'Fries', code: '15' }] } }),
        field('short_text', 'price'),
        field('number', 'qty'),
        field('calculation', 'line', { config: { expr: perRow, resultType: 'number', display: 'visible' } }),
        field('calculation', 'total', {
          config: {
            expr: { k: 'call', fn: 'sum', args: [{ k: 'ref', ref: { kind: 'answer', blockId: bid('price') } }] },
            resultType: 'number',
            display: 'visible',
          },
        }),
      ],
      [page('p1', ['items', 'total'])],
      [fill],
    );
    const rows = a.group([
      { rowId: 'row_1', values: { [bid('item')]: a.single('burger'), [bid('qty')]: a.number('2') } },
      { rowId: 'row_2', values: { [bid('item')]: a.single('fries'), [bid('qty')]: a.number('3') } },
    ]);
    const state = evaluate(versionOf(def), { [bid('items')]: rows }, META, 'client');
    expect(state.rowValues?.[bid('line')]).toEqual({
      row_1: { t: 'number', v: '80' },
      row_2: { t: 'number', v: '45' },
    });
    expect(state.values[bid('total')]).toEqual({ type: 'calculation', value: { t: 'number', v: '55' } });
    expect(state.rowValues?.[bid('price')]).toEqual({
      row_1: { t: 'text', v: '40' },
      row_2: { t: 'text', v: '15' },
    });
  });

  it('copies the selected option value into a text field', () => {
    const def = form(
      [
        field('single_choice', 'menu', { config: { display: 'dropdown', options: [{ id: oid('burger'), label: 'Burger', code: '467' }] } }),
        field('short_text', 'price'),
      ],
      [page('p1', ['menu', 'price'])],
      [rule('fill', cond(ans('menu'), 'is_answered'), [{
        type: 'set_value',
        target: bid('price'),
        value: { k: 'call', fn: 'option_code', args: [{ k: 'ref', ref: { kind: 'answer', blockId: bid('menu') } }] },
      }])],
    );
    const version = versionOf(def);
    const state = evaluate(version, { [bid('menu')]: a.single('burger') }, META, 'client');
    expect(state.values[bid('price')]).toEqual({ type: 'short_text', value: '467' });
    const session = createEvaluator(version, META, 'client');
    session.evaluate({});
    const next = session.update({ [bid('menu')]: a.single('burger') }, [bid('menu')]);
    expect(next.values[bid('price')]).toEqual({ type: 'short_text', value: '467' });
  });

  it('treats “is” between an option and the first characters as the option value', () => {
    const prefix = expr({ k: 'call', fn: 'left', args: [{ k: 'ref', ref: { kind: 'answer', blockId: bid('gstin') } }, { k: 'lit', value: { type: 'number', value: '2' as S.DecimalString } }] });
    const def = form(
      [
        field('single_choice', 'state', { config: { display: 'dropdown', options: [
          { id: oid('mh'), label: 'Maharashtra', code: '27' },
          { id: oid('ka'), label: 'Karnataka', code: '29' },
        ] } }),
        field('short_text', 'gstin'),
        field('short_text', 'igst'),
      ],
      [page('p1', ['state', 'gstin', 'igst'])],
      [rule('gst', cond(ans('state'), 'eq', prefix), [hide('igst')], [show('igst')])],
    );
    const match = evaluate(versionOf(def), { [bid('state')]: a.single('mh'), [bid('gstin')]: a.text('27AAAAA0000A1Z5') }, META, 'client');
    expect(match.visible.has(bid('igst'))).toBe(false);
    const mismatch = evaluate(versionOf(def), { [bid('state')]: a.single('mh'), [bid('gstin')]: a.text('29AAAAA0000A1Z5') }, META, 'client');
    expect(mismatch.visible.has(bid('igst'))).toBe(true);
  });

  it('blocks submit when a text field does not start with another field’s option code', () => {
    const def = form(
      [
        field('single_choice', 'state', { config: { display: 'dropdown', options: [
          { id: oid('mh'), label: 'Maharashtra', code: '27' },
          { id: oid('ka'), label: 'Karnataka', code: '29' },
        ] } }),
        field('short_text', 'gstin'),
      ],
      [page('p1', ['state', 'gstin'])],
      [rule(
        'gst',
        all(cond(ans('gstin'), 'is_answered'), cond(ans('gstin'), 'not_starts_with', ans('state'))),
        [{ type: 'block_submit', message: 'GSTIN does not match the selected state', atPage: pid('p1'), anchorBlockId: bid('gstin') }],
      )],
    );
    const mismatch = evaluate(versionOf(def), { [bid('state')]: a.single('mh'), [bid('gstin')]: a.text('29AAAAA0000A1Z5') }, META, 'client');
    expect(mismatch.submitBlocks).toEqual([{
      ruleId: id('gst'),
      message: 'GSTIN does not match the selected state',
      atPage: pid('p1'),
      anchorBlockId: bid('gstin'),
    }]);
    const match = evaluate(versionOf(def), { [bid('state')]: a.single('mh'), [bid('gstin')]: a.text('27AAAAA0000A1Z5') }, META, 'client');
    expect(match.submitBlocks).toEqual([]);
  });

  it('refuses a version compiled by another engine', () => {
    const version = versionOf(form(blocks(), pages()));
    expect(() => evaluate({ ...version, compiled: { ...version.compiled, engine: 'logic@1' as 'logic@2' } }, {}, META, 'client')).toThrow(/logic@1/);
  });
});
