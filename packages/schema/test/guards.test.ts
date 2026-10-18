import { describe, expect, it } from 'vitest';
import * as S from '../src/index.ts';
import { V1 } from '../src/index.ts';
import { depthGuard, guardOf, ownProtoKey, richTextLimitError } from '../src/v2/zod/_util.ts';
import { definition } from './fixtures.ts';

type Rec = Record<string, unknown>;
const isSchema = (v: unknown): v is { _zod: { def: Rec } } => typeof v === 'object' && v !== null && '_zod' in v;
const isPlain = (v: unknown): v is Rec => typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/** Every zod schema the package exports, including the per-type maps (BLOCK_SCHEMAS, ANSWER_VALUE_SCHEMAS, …). */
function exportedSchemas(): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [module, exports] of [['S', S], ['V1', V1]] as const) {
    for (const [name, value] of Object.entries(exports)) {
      if (isSchema(value)) out.push([`${module}.${name}`, value]);
      else if (isPlain(value)) for (const [key, inner] of Object.entries(value)) if (isSchema(inner)) out.push([`${module}.${name}.${key}`, inner]);
    }
  }
  return out;
}

interface Findings { unguardedLazy: boolean; records: Set<unknown>; keyedOuts: Set<unknown> }

/** Walks a schema's definition graph; a lazy reached before any depth or rich-text guard means hostile nesting can overflow the stack. */
function inspect(root: unknown): Findings {
  const found: Findings = { unguardedLazy: false, records: new Set(), keyedOuts: new Set() };
  const seen = new Set<string>();
  const ids = new Map<unknown, number>();
  const stack: Array<[unknown, boolean]> = [[root, false]];
  for (let item = stack.pop(); item; item = stack.pop()) {
    const [schema, safe] = item;
    if (!isSchema(schema)) continue;
    const id = ids.get(schema) ?? ids.set(schema, ids.size).size - 1;
    if (seen.has(`${id}:${safe}`)) continue;
    seen.add(`${id}:${safe}`);
    const def = schema._zod.def;
    const check = guardOf(schema);
    const below = safe || check === depthGuard || check === richTextLimitError;
    if (check === ownProtoKey) found.keyedOuts.add(def['out']);
    const catchall = def['catchall'];
    if (def['type'] === 'record' || (def['type'] === 'object' && isSchema(catchall) && catchall._zod.def['type'] !== 'never')) found.records.add(schema);
    if (def['type'] === 'lazy') {
      if (!below) found.unguardedLazy = true;
      stack.push([(def['getter'] as () => unknown)(), below]);
      continue;
    }
    for (const [key, value] of Object.entries(def)) {
      if (key === 'checks') continue;
      const children = Array.isArray(value) ? value : isPlain(value) ? Object.values(value) : [value];
      for (const child of children) if (isSchema(child)) stack.push([child, below]);
    }
  }
  return found;
}

const nestExpr = (depth: number): unknown => {
  let expr: unknown = { k: 'lit', value: { type: 'null' } };
  for (let i = 0; i < depth; i += 1) expr = { k: 'unary', op: 'not', arg: expr };
  return expr;
};
const nestScalar = (depth: number): unknown => {
  let value: unknown = { t: 'null' };
  for (let i = 0; i < depth; i += 1) value = { t: 'list', of: 'text', items: [value] };
  return value;
};
const nestList = (depth: number): unknown => {
  let item: unknown = { type: 'listItem', content: [{ type: 'paragraph' }] };
  for (let i = 0; i < depth; i += 1) item = { type: 'listItem', content: [{ type: 'bulletList', content: [item] }] };
  return item;
};
const nestGroupAnswer = (depth: number): unknown => {
  let answer: unknown = { type: 'short_text', value: 'x' };
  for (let i = 0; i < depth; i += 1) answer = { type: 'repeating_group', value: { rows: [{ rowId: 'r', values: { b: answer } }] } };
  return answer;
};

describe('recursion is bounded before zod recurses', () => {
  const schemas = exportedSchemas();

  it('finds the exports', () => {
    expect(schemas.length).toBeGreaterThan(300);
  });

  it('no exported schema reaches a z.lazy without a depth or rich-text guard first', () => {
    expect(schemas.filter(([, schema]) => inspect(schema).unguardedLazy).map(([name]) => name)).toEqual([]);
  });

  const DEEP = 10_000;
  const expr = nestExpr(DEEP);
  const list = nestList(DEEP);
  const group = nestGroupAnswer(DEEP);
  const condition = { kind: 'condition', id: 'c', left: { kind: 'expr', expr }, op: 'is_empty' };
  const cases: Array<[string, { safeParse(v: unknown): { success: boolean } }, unknown]> = [
    ['ExprSchema', S.ExprSchema, expr],
    ['OperandSchema', S.OperandSchema, { kind: 'expr', expr }],
    ['ConditionSchema', S.ConditionSchema, condition],
    ['ConditionGroupSchema', S.ConditionGroupSchema, { kind: 'group', id: 'g', combinator: 'all', children: [condition] }],
    ['ScalarValueSchema', S.ScalarValueSchema, nestScalar(DEEP)],
    ['AnswerValueSchema', S.AnswerValueSchema, group],
    ['StoredAnswerSchema', S.StoredAnswerSchema, group],
    ['ANSWER_VALUE_SCHEMAS.repeating_group', S.ANSWER_VALUE_SCHEMAS.repeating_group, group],
    ['AnswersSchema', S.AnswersSchema, { b: group }],
    ['ListItemNodeSchema', S.ListItemNodeSchema, list],
    ['BulletListNodeSchema', S.BulletListNodeSchema, { type: 'bulletList', content: [list] }],
    ['OrderedListNodeSchema', S.OrderedListNodeSchema, { type: 'orderedList', content: [list] }],
    ['RichBlockNodeSchema', S.RichBlockNodeSchema, { type: 'bulletList', content: [list] }],
    ['RichDocSchema', S.RichDocSchema, { type: 'doc', content: [{ type: 'bulletList', content: [list] }] }],
    ['EmailBodyNodeSchema', S.EmailBodyNodeSchema, { type: 'bulletList', content: [list] }],
    ['EmailDocSchema', S.EmailDocSchema, { type: 'email_doc', content: [{ type: 'bulletList', content: [list] }] }],
  ];
  it.each(cases)('%s returns an error for 10k-deep input instead of throwing', (_, schema, input) => {
    expect(() => schema.safeParse(input)).not.toThrow();
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe('record keys are never dropped silently', () => {
  it('every exported record and loose object rejects an own __proto__ key instead of dropping it', () => {
    const unkeyed: string[] = [];
    for (const [name, schema] of exportedSchemas()) {
      const { records, keyedOuts } = inspect(schema);
      if ([...records].some((r) => !keyedOuts.has(r))) unkeyed.push(name);
    }
    expect(unkeyed).toEqual([]);
  });

  it('ids and field keys never name Object.prototype members', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      expect(S.BlockIdSchema.safeParse(reserved).success).toBe(false);
      expect(S.OptionIdSchema.safeParse(reserved).success).toBe(false);
      expect(S.FieldKeySchema.safeParse(reserved).success).toBe(false);
      expect(S.isOpaqueId(reserved)).toBe(false);
    }
    expect(S.BlockIdSchema.safeParse('proto_1').success).toBe(true);
  });

  it('a __proto__ key fails the parse', () => {
    const answers = JSON.parse('{"__proto__":{"type":"short_text","value":"secret"},"b1":{"type":"short_text","value":"x"}}') as unknown;
    const parsed = S.AnswersSchema.safeParse(answers);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/__proto__/);

    const def = definition();
    const hostile = JSON.parse(JSON.stringify(def).replace('"blocks":{', '"blocks":{"__proto__":{},')) as unknown;
    expect(S.FormDefinitionSchema.safeParse(JSON.parse(JSON.stringify(def))).success).toBe(true);
    expect(S.FormDefinitionSchema.safeParse(hostile).success).toBe(false);

    expect(S.ExtensionsSchema.safeParse(JSON.parse('{"x-a":1,"__proto__":{"x-b":2}}')).success).toBe(false);
    expect(S.StoredBlockSchema.safeParse(JSON.parse('{"id":"z1","type":"future","__proto__":{"a":1}}')).success).toBe(false);
    expect(V1.FormBlockSchema.shape.customize.safeParse(JSON.parse('{"__proto__":{"a":1}}')).success).toBe(false);
  });
});
