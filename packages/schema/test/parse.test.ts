import { describe, expect, it } from 'vitest';
import * as S from '../src/index.ts';
import { definition, ids, inline } from './fixtures.ts';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe('runtime twins reject what the types reject', () => {
  const when = { kind: 'group', id: 'g', combinator: 'all', children: [] };

  it('server-only actions never parse as client rules', () => {
    expect(ok(S.ClientRuleSchema, { id: 'r', enabled: true, when, then: [{ type: 'show', targets: ['b'] }] })).toBe(true);
    expect(ok(S.ClientRuleSchema, { id: 'r', enabled: true, when, then: [{ type: 'mark_spam', reason: 'x' }] })).toBe(false);
    expect(ok(S.RuleSchema, { id: 'r', enabled: true, when, then: [{ type: 'mark_spam', reason: 'x' }] })).toBe(true);
  });

  it('number answers are DecimalStrings', () => {
    expect(ok(S.AnswerValueSchema, { type: 'number', value: '3.50' })).toBe(true);
    expect(ok(S.AnswerValueSchema, { type: 'number', value: 3 })).toBe(false);
    expect(ok(S.AnswerValueSchema, { type: 'number', value: '1e3' })).toBe(false);
  });

  it('a present answer is never empty (I9)', () => {
    const answer = (type: string, value: unknown) => ok(S.AnswerValueSchema, { type, value });
    expect(answer('context', '')).toBe(false);
    expect(answer('context', 'utm')).toBe(true);
    expect(answer('multi_choice', { optionIds: [] })).toBe(false);
    expect(answer('multi_choice', { optionIds: [], other: '' })).toBe(false);
    expect(answer('multi_choice', { optionIds: [], other: 'Something else' })).toBe(true);
    expect(answer('multi_choice', { optionIds: ['a'] })).toBe(true);
    expect(answer('single_choice', { optionId: null })).toBe(false);
    expect(answer('single_choice', { optionId: null, other: 'Mine' })).toBe(true);
    expect(answer('full_name', {})).toBe(false);
    expect(answer('full_name', { first: '' })).toBe(false);
    expect(answer('full_name', { first: 'Asha' })).toBe(true);
    expect(answer('address', {})).toBe(false);
    expect(answer('address', { city: '' })).toBe(false);
    expect(answer('address', { city: 'Pune' })).toBe(true);
    expect(ok(S.AnswersSchema, { b1: { type: 'multi_choice', value: { optionIds: [] } } })).toBe(false);
    expect(answer('matrix', { mode: 'single', rows: {} })).toBe(false);
    expect(answer('matrix', { mode: 'single', rows: { r1: 'c1' } })).toBe(true);
    expect(answer('matrix', { mode: 'multi', rows: { r1: [] } })).toBe(false);
    expect(answer('matrix', { mode: 'grid', rows: { r1: {} } })).toBe(false);
    expect(answer('matrix', { mode: 'grid', rows: { r1: { c1: '' } } })).toBe(false);
    expect(answer('matrix', { mode: 'grid', rows: { r1: { c1: true } } })).toBe(true);
    expect(answer('repeating_group', { rows: [] })).toBe(false);
    expect(answer('repeating_group', { rows: [{ rowId: 'row_1', values: { b2: { type: 'short_text', value: 'x' } } }] })).toBe(true);
    const consent = { noticeLocale: 'en-IN', noticeVersion: 1 };
    expect(answer('consent', { ...consent, items: {} })).toBe(false);
    expect(answer('consent', { ...consent, items: { item_1: false } })).toBe(true);
    expect(answer('payment', { currency: 'INR' })).toBe(false);
    expect(answer('payment', { currency: 'INR', items: [] })).toBe(false);
    expect(answer('payment', { currency: 'INR', customAmount: '49900' })).toBe(true);
    expect(answer('payment', { currency: 'INR', items: [{ productId: 'p1', quantity: 1 }] })).toBe(true);
  });

  it('template recipients are placeholders only', () => {
    expect(ok(S.RecipientPlaceholderSchema, { kind: 'field', blockId: 'email_1' })).toBe(true);
    expect(ok(S.RecipientPlaceholderSchema, { kind: 'email', address: 'a@b.co' })).toBe(false);
    expect(ok(S.RecipientPlaceholderSchema, { kind: 'member', userId: 'u1' })).toBe(false);
  });

  it('answers without consent are never stored', () => {
    const privacy = definition().privacy;
    expect(ok(S.PrivacyConfigSchema, privacy)).toBe(true);
    expect(ok(S.PrivacyConfigSchema, { ...privacy, dropAnswersWithoutConsent: false })).toBe(false);
  });

  it('server rule steps never reach the runtime plan', () => {
    expect(ok(S.PlanStepSchema, { kind: 'rule', ruleId: 'r', scope: 'server' })).toBe(true);
    const plan = S.RuntimeFormVersionSchema.shape.compiled.shape.plan;
    expect(ok(plan, [{ kind: 'rule', ruleId: 'r', scope: 'client+server' }, { kind: 'calc', blockId: 'b' }])).toBe(true);
    expect(ok(plan, [{ kind: 'rule', ruleId: 'r', scope: 'server' }])).toBe(false);
  });

  it('consent items are never pre-ticked', () => {
    const item = { id: 'i', label: inline('Yes'), requiredToSubmit: false, defaultChecked: false };
    expect(ok(S.ConsentItemSchema, item)).toBe(true);
    expect(ok(S.ConsentItemSchema, { ...item, defaultChecked: true })).toBe(false);
  });
});

describe('primitives', () => {
  it('validates branded strings', () => {
    expect(ok(S.BlockIdSchema, '0190a5d2-7c1e-7e2b-9f00-0a1b2c3d4e5f')).toBe(true);
    expect(ok(S.BlockIdSchema, 'has space')).toBe(false);
    expect(ok(S.FieldKeySchema, 'full_name')).toBe(true);
    expect(ok(S.FieldKeySchema, 'Full Name')).toBe(false);
    expect(ok(S.DecimalStringSchema, '-12.5')).toBe(true);
    expect(ok(S.DecimalStringSchema, '01')).toBe(false);
    expect(ok(S.DecimalStringSchema, '-0')).toBe(false);
    expect(ok(S.DecimalStringSchema, '1'.repeat(35))).toBe(false);
    expect(ok(S.MinorUnitsSchema, '49900')).toBe(true);
    expect(ok(S.MinorUnitsSchema, '499.00')).toBe(false);
    expect(ok(S.MinorUnitsSchema, '9223372036854775807')).toBe(true);
    expect(ok(S.MinorUnitsSchema, '-9223372036854775808')).toBe(true);
    expect(ok(S.MinorUnitsSchema, '9223372036854775808')).toBe(false);
    expect(ok(S.MinorUnitsSchema, '-9223372036854775809')).toBe(false);
    expect(ok(S.MinorUnitsSchema, '1'.repeat(20))).toBe(false);
    expect(ok(S.MinorUnitsSchema, '-0')).toBe(false);
    expect(ok(S.IsoDateSchema, '2028-02-29')).toBe(true);
    expect(ok(S.IsoDateSchema, '2027-02-29')).toBe(false);
    expect(ok(S.IsoTimeSchema, '23:59')).toBe(true);
    expect(ok(S.IsoTimeSchema, '24:00')).toBe(false);
    expect(ok(S.IsoInstantSchema, '2027-05-13T10:00:00.123Z')).toBe(true);
    expect(ok(S.IsoInstantSchema, '2027-05-13T10:00:00+05:30')).toBe(false);
    expect(ok(S.HexColorSchema, '#2383e2')).toBe(true);
    expect(ok(S.HexColorSchema, 'red')).toBe(false);
    expect(ok(S.TemplateVariableNameSchema, 'org.privacy_contact.email')).toBe(true);
    expect(ok(S.TemplateVariableNameSchema, 'form.purpose[]')).toBe(false);
  });

  it('allowlists link schemes (S4, S6)', () => {
    for (const href of ['https://example.org/a?b=c#d', 'http://localhost:8080', 'mailto:a@b.co', 'tel:+91 98765 43210']) expect(ok(S.SafeHrefSchema, href)).toBe(true);
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pass@evil.example', '//example.org', 'vbscript:x']) expect(ok(S.SafeHrefSchema, href)).toBe(false);
    expect(ok(S.SafeUrlSchema, 'mailto:a@b.co')).toBe(false);
  });

  it('extensions are x- namespaced', () => {
    expect(ok(S.ExtensionsSchema, { 'x-acme': { any: 1 } })).toBe(true);
    expect(ok(S.ExtensionsSchema, { acme: 1 })).toBe(false);
  });
});

describe('rich text', () => {
  const doc = (content: unknown[]) => ({ type: 'doc', content });

  it('accepts the TipTap subset', () => {
    expect(ok(S.RichDocSchema, doc([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hi', marks: [{ type: 'bold' }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'pipe', attrs: { source: { kind: 'answer', blockId: 'b' } } }] }] }] },
      { type: 'paragraph', content: [{ type: 'var', attrs: { name: 'org.legal_name' } }, { type: 'hardBreak' }] },
      { type: 'image', attrs: { asset: { ref: 'brand.logo' } } },
    ]))).toBe(true);
  });

  it('rejects HTML-ish and unknown nodes, external images and empty text', () => {
    expect(ok(S.RichDocSchema, doc([{ type: 'html', content: '<b>x</b>' }]))).toBe(false);
    expect(ok(S.RichDocSchema, doc([{ type: 'image', attrs: { asset: { url: 'https://evil.example/x.png' } } }]))).toBe(false);
    expect(ok(S.RichDocSchema, doc([{ type: 'paragraph', content: [{ type: 'text', text: '' }] }]))).toBe(false);
  });

  it('InlineDoc is exactly one paragraph', () => {
    expect(ok(S.InlineDocSchema, inline('x'))).toBe(true);
    expect(ok(S.InlineDocSchema, doc([]))).toBe(false);
    expect(ok(S.InlineDocSchema, doc([{ type: 'paragraph' }, { type: 'paragraph' }]))).toBe(false);
  });

  it('enforces node, depth and list limits before parsing', () => {
    const many = doc(Array.from({ length: 10_001 }, () => ({ type: 'paragraph', content: [{ type: 'text', text: 'x' }] })));
    expect(ok(S.RichDocSchema, many)).toBe(false);
    expect(S.measureRichText(many).nodes).toBeGreaterThan(S.RICH_TEXT_LIMITS.maxNodes);
    const nest = (levels: number) => {
      let node: unknown = { type: 'paragraph' };
      for (let i = 0; i < levels; i += 1) node = { type: 'bulletList', content: [{ type: 'listItem', content: [node] }] };
      return doc([node]);
    };
    expect(ok(S.RichDocSchema, nest(3))).toBe(true);
    expect(ok(S.RichDocSchema, nest(4))).toBe(false);
    expect(S.richTextLimitError(nest(5))).toMatch(/deeper than 8/);
  });
});

describe('recursion is bounded', () => {
  it('a hostile 100k-deep expression fails cleanly instead of overflowing the stack', () => {
    let expr: unknown = { k: 'lit', value: { type: 'null' } };
    for (let i = 0; i < 100_000; i += 1) expr = { k: 'unary', op: 'not', arg: expr };
    expect(() => S.ExprSchema.safeParse(expr)).not.toThrow();
    expect(ok(S.ExprSchema, expr)).toBe(false);
  });

  it('ordinary nesting parses', () => {
    let expr: unknown = { k: 'ref', ref: { kind: 'variable', varId: 'v' } };
    for (let i = 0; i < 30; i += 1) expr = { k: 'binary', op: '+', left: expr, right: { k: 'lit', value: { type: 'number', value: '1' } } };
    expect(ok(S.ExprSchema, expr)).toBe(true);
  });
});

describe('definitions', () => {
  it('parses the fixture', () => {
    const def = definition();
    expect(S.FormDefinitionSchema.parse(def)).toEqual(def);
  });

  it('rejects unknown keys instead of dropping them (ADR-0002 §1)', () => {
    const def = definition();
    const top = S.FormDefinitionSchema.safeParse({ ...def, order: 3 });
    expect(top.success).toBe(false);
    expect(top.error?.issues).toEqual([expect.objectContaining({ code: 'unrecognized_keys', keys: ['order'], path: [] })]);
    const block = def.blocks[ids.name];
    expect(ok(S.FormDefinitionSchema, { ...def, blocks: { ...def.blocks, [ids.name]: { ...block, order: 1 } } })).toBe(false);
    const answer = { type: 'short_text', value: 'Asha' };
    expect(ok(S.StoredAnswerSchema, answer)).toBe(true);
    expect(ok(S.StoredAnswerSchema, { ...answer, enc: { v: 1 } })).toBe(false);
    expect(ok(S.SubmitResultSchema, { ok: false, kind: 'closed', retryAfter: 5 })).toBe(false);
  });

  it('keeps blocks of unknown type as UnsupportedBlock (forward compatibility)', () => {
    const raw = { id: 'future_1', type: 'hologram', config: { beam: true } };
    expect(S.StoredBlockSchema.parse(raw)).toEqual({ id: 'future_1', type: 'unsupported', originalType: 'hologram', raw });
    const def = definition();
    const parsed = S.FormDefinitionSchema.parse({ ...def, blocks: { ...def.blocks, future_1: raw } });
    expect(parsed.blocks['future_1' as S.BlockId]?.type).toBe('unsupported');
  });

  it('does not let a known block type with a broken config pass as unsupported', () => {
    expect(ok(S.StoredBlockSchema, { id: 'x', type: 'short_text', config: {} })).toBe(false);
  });

  it('nested discriminated unions dispatch correctly', () => {
    expect(S.SubmitResultSchema.parse({ ok: false, kind: 'closed' })).toEqual({ ok: false, kind: 'closed' });
    expect(ok(S.SubmitResultSchema, { ok: false, kind: 'invalid', status: 422, errors: [{ code: 'required', message: 'Required' }] })).toBe(true);
    expect(ok(S.SubmitResultSchema, { ok: true, kind: 'closed' })).toBe(false);
    expect(ok(S.ActionSchema, { type: 'start_workflow', workflowId: 'w' })).toBe(true);
    expect(ok(S.ActionSchema, { type: 'hide', targets: ['p1'] })).toBe(true);
  });
});
