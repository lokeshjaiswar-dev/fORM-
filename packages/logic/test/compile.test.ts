import { REGISTRY } from '@form/registry';
import { contentHash } from '@form/schema';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { compile, validateDefinition } from '../src/index.ts';
import {
  all, ans, bid, choices, compiled, cond, date, disable, expr, field, form, heading, hide, id, nil, num, opts, page, requireIt, rule, show, text, time,
} from './build.ts';

const codes = (issues: readonly S.PublishIssue[]) => issues.map((i) => `${i.severity}:${i.code}:${i.path}`);
const failure = (def: S.FormDefinition) => {
  const result = compile(def, REGISTRY);
  if (result.ok) throw new Error('expected compile to fail');
  return result.issues;
};

/* Page 1: name, colour (single choice), age. Page 2: heading, pets (multi choice), visit date. */
const blocks = () => [
  field('short_text', 'name'),
  field('single_choice', 'colour', { config: { display: 'radio', options: choices('red', 'blue') } }),
  field('number', 'age'),
  heading('intro'),
  field('multi_choice', 'pets', { config: { display: 'checkbox', options: choices('cat', 'dog', 'fish') } }),
  field('date', 'visit'),
];
const pages = () => [page('p1', ['name', 'colour', 'age']), page('p2', ['intro', 'pets', 'visit'])];

describe('compile', () => {
  it('derives placement, the plan, reads, requirements, the data inventory and the hash', () => {
    const def = form(blocks(), pages(), [
      rule('r_pets', cond(ans('colour'), 'eq', opts('colour', 'blue')), [show('pets')]),
      rule('r_visit', cond(ans('age'), 'gte', num('18')), [requireIt('visit')]),
    ]);
    def.blocks[bid('pets')] = { ...field('multi_choice', 'pets', { config: { display: 'checkbox', options: choices('cat', 'dog', 'fish') } }), initiallyHidden: true };
    const c = compiled(def);
    expect(c.engine).toBe('logic@2');
    expect(c.requires).toEqual(['logic@2', 'rich_text@1', 'schema@2']);
    expect(c.documentOrder).toEqual(['name', 'colour', 'age', 'intro', 'pets', 'visit']);
    expect(c.parentOf).toEqual({ name: 'p1', colour: 'p1', age: 'p1', intro: 'p2', pets: 'p2', visit: 'p2' });
    expect(c.pageOf).toEqual(c.parentOf);
    expect(c.plan).toEqual([
      { kind: 'on_path', pageId: 'p1' },
      { kind: 'on_path', pageId: 'p2' },
      { kind: 'rule', ruleId: 'r_pets', scope: 'client+server' },
      { kind: 'rule', ruleId: 'r_visit', scope: 'client+server' },
    ]);
    expect(c.reads).toEqual({
      'on_path:p1': ['visible:p1'],
      'on_path:p2': ['jump:p1', 'onPath:p1', 'visible:p1', 'visible:p2'],
      'rule:r_pets': ['onPath:p1', 'value:colour', 'visible:colour', 'visible:p1'],
      'rule:r_visit': ['onPath:p1', 'value:age', 'visible:age', 'visible:p1'],
    });
    expect(c.taint).toEqual({});
    expect(c.dataInventory).toEqual([{ purposeId: 'respond', blockIds: ['name'], classifications: ['personal'] }]);
    expect(c.definitionHash).toBe(contentHash(def));
  });

  it('lists each purpose with its blocks and classifications', () => {
    const purpose = id<S.PurposeId>('respond');
    const def = form([
      field('short_text', 'name', { compliance: { ...field('short_text', 'x').compliance, classification: 'personal', purposeIds: [purpose] } }),
      field('email', 'mail', { compliance: { ...field('email', 'x').compliance, classification: 'sensitive', purposeIds: [purpose] } }),
    ], [page('p1', ['name', 'mail'])]);
    expect(compiled(def).dataInventory).toEqual([{ purposeId: 'respond', blockIds: ['name', 'mail'], classifications: ['personal', 'sensitive'] }]);
  });

  it('marks expression operands with expr@1 and adds edition capabilities', () => {
    const def = form(blocks(), pages(), [
      rule('r', cond(expr({ k: 'binary', op: '>', left: { k: 'ref', ref: { kind: 'answer', blockId: bid('age') } }, right: { k: 'lit', value: { type: 'number', value: id('17') } } }), 'is_true'), [show('visit')]),
    ]);
    def.theme.layout = 'cards';
    expect(compiled(def).requires).toEqual(['cards_layout', 'expr@1', 'logic@2', 'rich_text@1', 'schema@2']);
  });

  describe('missing_capability is fatal (ADR-0002 §2)', () => {
    it('for a registry stub, even though a draft only warns', () => {
      const def = form([field('full_name', 'who')], [page('p1', ['who'])]);
      expect(codes(validateDefinition(def, 'save', REGISTRY))).toEqual(['warning:missing_capability:/blocks/who']);
      expect(codes(validateDefinition(def, 'publish', REGISTRY))).toEqual(['error:missing_capability:/blocks/who']);
      expect(codes(failure(def))).toEqual(['error:missing_capability:/blocks/who']);
    });

    it('for logic outside the P0 subset', () => {
      const def = form(blocks(), pages(), [
        rule('r1', cond(ans('age'), 'gt', num('1')), [{ type: 'set_value', target: bid('name'), value: { k: 'lit', value: { type: 'text', value: 'x' } } }]),
        rule('r2', cond(ans('name'), 'matches_preset', text('in_pan')), [show('visit')]),
        rule('r3', cond(ans('visit'), 'after', { kind: 'literal', value: { type: 'relative_date', offset: 1, unit: 'day' } }), [show('age')]),
        rule('r4', cond(expr({ k: 'call', fn: 'len', args: [] }), 'is_true'), [show('age')]),
        rule('r5', cond({ kind: 'ref', ref: { kind: 'meta', key: 'today' } }, 'is_answered'), [show('age')]),
        rule('r6', cond(ans('age'), 'gt', num('1')), [{ type: 'route_email', notificationId: id('n1'), field: 'to', mode: 'add', recipients: [] }]),
      ]);
      def.logic.variables = [{ id: id('v1'), key: id('v1'), name: 'v', type: 'number', expr: { k: 'lit', value: { type: 'number', value: id('1') } }, persist: false }];
      expect(codes(failure(def)).filter((c) => c.includes('missing_capability'))).toEqual([
        'error:missing_capability:/logic/rules/0/then/0',
        'error:missing_capability:/logic/rules/1/when/children/0/op',
        'error:missing_capability:/logic/rules/2/when/children/0/right/value',
        'error:missing_capability:/logic/rules/3/when/children/0/left/expr',
        'error:missing_capability:/logic/rules/4/when/children/0/left/ref',
        'error:missing_capability:/logic/rules/5/then/0',
        'error:missing_capability:/logic/variables/0',
      ]);
      expect(compiled(form(blocks(), pages(), [{ ...rule('r1', cond(ans('age'), 'gt', num('1')), [{ type: 'set_value', target: bid('name'), value: { k: 'lit', value: { type: 'text', value: 'x' } } }]), enabled: false }]))).toBeTruthy();
    });

    it('for a rule reading a stub block', () => {
      const def = form([field('address', 'home'), field('short_text', 'name')], [page('p1', ['home', 'name'])], [rule('r', cond(ans('home'), 'is_answered'), [show('name')])]);
      expect(codes(failure(def))).toContain('error:missing_capability:/logic/rules/0/when/children/0/left/ref');
    });
  });

  it('B21: disables a rule whose source block was deleted (a draft warning, a publish error)', () => {
    const def = form(blocks(), pages(), [
      rule('r_gone', cond(ans('deleted'), 'eq', text('yes')), [hide('visit')]),
      rule('r_opt', cond(ans('colour'), 'includes_any', opts('colour', 'green')), [hide('intro')]),
      rule('r_ok', cond(ans('age'), 'gte', num('18')), [requireIt('visit')]),
    ]);
    const c = compiled(def);
    /* Only a dangling block disables the rule; an unknown option id stays a warning. */
    expect(c.plan.filter((s) => s.kind === 'rule').map((s) => (s.kind === 'rule' ? s.ruleId : ''))).toEqual(['r_opt', 'r_ok']);
    expect(c.definitionHash).toBe(contentHash(def));
    expect(codes(validateDefinition(def, 'save', REGISTRY))).toEqual([
      'warning:dangling_ref:/logic/rules/0/when/children/0/left/ref/blockId',
      'warning:dangling_ref:/logic/rules/1/when/children/0/right/optionIds/0',
    ]);
    expect(codes(validateDefinition(def, 'publish', REGISTRY))).toEqual([
      'error:dangling_ref:/logic/rules/0/when/children/0/left/ref/blockId',
      'error:dangling_ref:/logic/rules/1/when/children/0/right/optionIds/0',
    ]);
  });

  it('a hidden value whose source block was deleted compiles and reads as null', () => {
    const def = form([...blocks(), field('hidden', 'copy', { config: { source: { kind: 'expr', expr: { k: 'ref', ref: { kind: 'answer', blockId: bid('gone') } } } } })], [
      page('p1', ['name', 'colour', 'age', 'copy']), page('p2', ['intro', 'pets', 'visit']),
    ]);
    expect(compile(def, REGISTRY).ok).toBe(true);
    expect(codes(validateDefinition(def, 'save', REGISTRY))).toEqual(['warning:dangling_ref:/blocks/copy/config/source/expr/ref/blockId']);
  });

  describe('operand types', () => {
    const issuesOf = (when: S.Condition) => codes(validateDefinition(form(blocks(), pages(), [rule('r', when, [show('intro')])]), 'save', REGISTRY));

    it('accepts every P0 comparison on its own kind', () => {
      const ok: S.Condition[] = [
        cond(ans('name'), 'contains', text('a'), { caseSensitive: true }),
        cond(ans('name'), 'neq', nil()),
        cond(ans('age'), 'between', num('1'), { right2: num('9') }),
        cond(ans('colour'), 'includes_none', opts('colour', 'red')),
        cond(ans('pets'), 'count_gte', num('2')),
        cond(ans('pets', 'count'), 'lte', num('2')),
        cond(ans('pets', 'other'), 'starts_with', text('x')),
        cond(ans('visit'), 'on_or_after', date('2026-01-01')),
        cond({ kind: 'ref', ref: { kind: 'meta', key: 'url_param', name: 'src' } }, 'eq', text('ad')),
        cond({ kind: 'ref', ref: { kind: 'meta', key: 'is_preview' } }, 'is_false'),
      ];
      for (const c of ok) expect(issuesOf(c)).toEqual([]);
    });

    it('rejects operators and values of the wrong kind', () => {
      expect(issuesOf(cond(ans('name'), 'gt', num('1')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/op']);
      expect(issuesOf(cond(ans('age'), 'eq', text('1')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/right']);
      expect(issuesOf(cond(ans('colour'), 'eq', opts('pets', 'cat')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/right']);
      expect(issuesOf(cond(ans('colour'), 'eq', text('red')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/right']);
      expect(issuesOf(cond(ans('pets'), 'count_eq', num('1.5')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/right']);
      expect(issuesOf(cond(ans('visit'), 'lt', date('2026-01-01')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/op']);
      expect(issuesOf(cond(ans('visit'), 'before', time('10:00')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/right']);
      expect(issuesOf(cond(ans('age'), 'between', num('1')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0']);
      expect(issuesOf(cond(ans('age'), 'gt'))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0']);
      expect(issuesOf(cond(ans('age'), 'is_answered', num('1')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/right']);
      expect(issuesOf(cond(ans('intro'), 'is_answered'))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/left/ref']);
      expect(issuesOf(cond(ans('name', 'first'), 'is_answered'))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/left/ref']);
      expect(issuesOf(cond(opts('colour', 'red'), 'eq', opts('colour', 'red')))).toEqual(['error:operator_type_mismatch:/logic/rules/0/when/children/0/left']);
      expect(issuesOf(cond({ kind: 'ref', ref: { kind: 'meta', key: 'url_param' } }, 'is_answered'))).toEqual(['error:expr_type_error:/logic/rules/0/when/children/0/left/ref']);
      expect(issuesOf(cond(expr({ k: 'binary', op: '<', left: { k: 'lit', value: { type: 'text', value: 'a' } }, right: { k: 'lit', value: { type: 'number', value: id('1') } } }), 'is_true')))
        .toEqual(['error:expr_type_error:/logic/rules/0/when/children/0/left/expr']);
    });

    it('limits condition depth, leaves and expression size', () => {
      let deep: S.ConditionGroup = all(cond(ans('age'), 'is_answered'));
      for (let i = 0; i < 5; i += 1) deep = all(deep);
      const wide = all(...Array.from({ length: 101 }, () => cond(ans('age'), 'is_answered')));
      let big: S.Expr = { k: 'lit', value: { type: 'number', value: id('1') } };
      for (let i = 0; i < 40; i += 1) big = { k: 'binary', op: '==', left: big, right: { k: 'lit', value: { type: 'null' } } };
      const def = form(blocks(), pages(), [rule('deep', deep, [show('visit')]), rule('wide', wide, [show('visit')]), rule('big', cond(expr(big), 'is_true'), [show('visit')])]);
      expect(codes(validateDefinition(def, 'save', REGISTRY)).filter((c) => c.includes('expr_too_large'))).toEqual([
        'error:expr_too_large:/logic/rules/0/when/children/0/children/0/children/0/children/0/children/0',
        'error:expr_too_large:/logic/rules/1/when',
        'error:expr_too_large:/logic/rules/2/when/children/0/left/expr',
      ]);
    });
  });

  describe('same-cell writers (schema §3.3.3)', () => {
    /* A (index 0) depends on B (index 5); C (index 2) also writes A's target. */
    const abc = (cActions: S.Action[] = []) => {
      const filler = (n: number) => rule(`f${n}`, cond(ans('colour'), 'is_answered'), [disable('age')]);
      return form(blocks(), pages(), [
        rule('A', cond(ans('name'), 'is_answered'), [hide('visit')], undefined, { name: 'A' }),
        filler(1),
        rule('C', cond(ans('age'), 'is_answered'), [show('visit'), ...cActions], undefined, { name: 'C' }),
        filler(3),
        filler(4),
        rule('B', cond(ans('colour'), 'eq', opts('colour', 'red')), [hide('name')], undefined, { name: 'B' }),
      ]);
    };

    it('golden: the later writer (C) runs after A even though A waits for B', () => {
      const c = compiled(abc());
      /* Without the writer edge A → C, C (index 2) would be ready first and A would win. */
      expect(c.plan.flatMap((s) => (s.kind === 'rule' ? [s.ruleId] : []))).toEqual(['f1', 'f3', 'f4', 'B', 'A', 'C']);
    });

    it('reports the cycle the writer edges create, with the conflicting-writers hint', () => {
      /* C now also hides `name`, which A reads: A must run before C (writers) and after it (data). */
      const issues = failure(abc([hide('name')])).filter((i) => i.code === 'logic_cycle');
      expect(issues).toEqual([{
        severity: 'error',
        code: 'logic_cycle',
        path: '/logic/rules/0',
        message: 'logic cycle: rule:A → (writes visible:visit before) → rule:C → (visible:name) → rule:A; conflicting writers: rule:A and rule:C both write visible:visit (the later rule must run last, so reorder or merge the rules)',
      }]);
    });
  });

  it('reports a cycle through visibility with its path', () => {
    const def = form(blocks(), pages(), [
      rule('r1', cond(ans('name'), 'is_answered'), [hide('age')]),
      rule('r2', cond(ans('age'), 'is_answered'), [hide('name')]),
      rule('self', cond(ans('colour'), 'is_answered'), [hide('colour')]),
    ]);
    expect(failure(def).filter((i) => i.code === 'logic_cycle').map((i) => `${i.path} ${i.message}`)).toEqual([
      '/logic/rules/0 logic cycle: rule:r1 → (visible:age) → rule:r2 → (visible:name) → rule:r1',
      '/logic/rules/2 logic cycle: rule:self → (visible:colour) → rule:self',
    ]);
  });

  describe('page order (I8)', () => {
    it('rejects logic for a page that reads a later page, transitively', () => {
      const def = form(blocks(), pages(), [
        rule('later', cond(ans('pets'), 'is_answered'), [hide('age')]),
        rule('chain', cond(ans('age'), 'is_answered'), [disable('colour')]),
        rule('fine', cond(ans('age'), 'is_answered'), [hide('visit')]),
      ]);
      expect(failure(def).filter((i) => i.code === 'page_order_violation').map((i) => `${i.path} ${i.message}`)).toEqual([
        '/logic/rules/0 rule:later sets visible:age on page 1 (p1) but reads value:pets on page 2 (p2); logic for a page may only read the same or earlier pages',
        '/logic/rules/1 rule:chain sets enabled:colour on page 1 (p1) but reads visible:age ← rule:later ← value:pets on page 2 (p2); logic for a page may only read the same or earlier pages',
      ]);
    });

    it('applies to validation bounds that read another block', () => {
      const def = form([
        field('date', 'start', { config: { pattern: 'DD-MM-YYYY', picker: 'calendar', limits: { max: { kind: 'field', blockId: bid('end') } } } }),
        field('date', 'end', { config: { pattern: 'DD-MM-YYYY', picker: 'calendar', limits: { min: { kind: 'field', blockId: bid('start') } } } }),
      ], [page('p1', ['start']), page('p2', ['end'])]);
      expect(codes(failure(def))).toEqual(['error:validation_bound_page_order:/blocks/start/config/limits/max']);
    });
  });

  it('warns about blocks and pages that start hidden and are never shown', () => {
    const def = form(blocks(), [page('p1', ['name', 'colour', 'age']), page('p2', ['intro', 'pets', 'visit'], { initiallyHidden: true })], [
      rule('r', cond(ans('age'), 'gt', num('3')), [show('pets')]),
    ]);
    def.blocks[bid('pets')] = { ...field('multi_choice', 'pets', { config: { display: 'checkbox', options: choices('cat') } }), initiallyHidden: true };
    def.blocks[bid('name')] = { ...field('short_text', 'name'), initiallyHidden: true };
    expect(codes(validateDefinition(def, 'save', REGISTRY))).toEqual([
      'warning:initially_hidden_never_shown:/pages/1/initiallyHidden',
      'warning:initially_hidden_never_shown:/blocks/name/initiallyHidden',
    ]);
    expect(compile(def, REGISTRY).ok).toBe(true);
  });

  it('captures hidden values, typed as text', () => {
    const def = form([
      field('short_text', 'name'),
      field('hidden', 'src', { config: { source: { kind: 'url_param', name: 'src' } } }),
      field('hidden', 'copy', { config: { source: { kind: 'expr', expr: { k: 'ref', ref: { kind: 'answer', blockId: bid('name') } } } } }),
      field('hidden', 'bad', { config: { source: { kind: 'expr', expr: { k: 'lit', value: { type: 'number', value: id('1') } } } } }),
    ], [page('p1', ['name', 'src', 'copy', 'bad'])]);
    expect(codes(failure(def))).toEqual(['error:expr_type_error:/blocks/bad/config/source/expr']);
    delete def.blocks[bid('bad')];
    def.pages[0] = page('p1', ['name', 'src', 'copy']);
    const c = compiled(def);
    expect(c.plan).toEqual([{ kind: 'on_path', pageId: 'p1' }, { kind: 'capture', blockId: 'src' }, { kind: 'capture', blockId: 'copy' }]);
    expect(c.taint).toEqual({ 'value:copy': { classification: 'personal', purposeIds: ['respond'] } });
    expect(c.requires).toContain('expr@1');
  });

  it('is deterministic: the same definition compiles to the same bytes', () => {
    const def = form(blocks(), pages(), [rule('r', cond(ans('colour'), 'eq', opts('colour', 'red')), [show('pets')])]);
    expect(JSON.stringify(compiled(structuredClone(def)))).toBe(JSON.stringify(compiled(def)));
  });
});
