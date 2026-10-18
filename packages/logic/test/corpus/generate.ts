import type { V1Block, V1Form, V1Operator, V1Option, V1Type, V1Values } from './v1.ts';

/* Seeded, engine-independent fixtures: integer PRNG only, no Math.random, no host locale. */

/** mulberry32: 32-bit integer state, identical output in every JavaScript engine. */
export function rng(seed: number): { next(): number; int(n: number): number; pick<T>(items: readonly T[]): T; chance(p: number): boolean } {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: (items) => items[int(items.length)] as never, chance: (p) => next() < p };
}

const option = (blockId: string, value: string, i: number): V1Option => ({ id: `${blockId}_o${i + 1}`, label: value.charAt(0).toUpperCase() + value.slice(1), value });
const options = (blockId: string, values: readonly string[]): V1Option[] => values.map((v, i) => option(blockId, v, i));

/** The five v1 system templates' logic, in miniature (contact, feedback, NPS, job application, event registration). */
const TEMPLATES: V1Form[] = [
  {
    name: 'contact',
    blocks: [
      { id: 'name', type: 'text', page: 0 },
      { id: 'email', type: 'email', page: 0 },
      { id: 'topic', type: 'dropdown', page: 0, options: options('topic', ['sales', 'support', 'other']) },
      { id: 'other_topic', type: 'text', page: 0, logic: { enabled: true, action: 'show', sourceBlockId: 'topic', operator: 'equals', value: 'other' } },
      { id: 'message', type: 'long_text', page: 0, logic: { enabled: true, action: 'hide', sourceBlockId: 'topic', operator: 'not_answered' } },
      /* 'billing' is not an option of `topic` (an option was renamed): v1 hid this block forever. */
      { id: 'billing_note', type: 'text', page: 0, logic: { enabled: true, action: 'show', sourceBlockId: 'topic', operator: 'equals', value: 'billing' } },
    ],
  },
  {
    name: 'feedback',
    blocks: [
      { id: 'stars', type: 'rating', page: 0 },
      { id: 'why_low', type: 'long_text', page: 0, logic: { enabled: true, action: 'show', sourceBlockId: 'stars', operator: 'less_than', value: '3' } },
      { id: 'praise', type: 'long_text', page: 0, logic: { enabled: true, action: 'show', sourceBlockId: 'stars', operator: 'greater_than', value: '3' } },
      { id: 'contact_ok', type: 'multiple_choice', page: 1, options: options('contact_ok', ['yes', 'no']) },
      { id: 'phone_note', type: 'text', page: 1, logic: { enabled: true, action: 'show', sourceBlockId: 'contact_ok', operator: 'equals', value: 'yes' } },
    ],
  },
  {
    name: 'nps',
    blocks: [
      { id: 'score', type: 'nps', page: 0 },
      { id: 'detractor', type: 'long_text', page: 0, logic: { enabled: true, action: 'show', sourceBlockId: 'score', operator: 'less_than', value: '7' } },
      { id: 'promoter', type: 'long_text', page: 0, logic: { enabled: true, action: 'show', sourceBlockId: 'score', operator: 'greater_than', value: '8' } },
      { id: 'follow_up', type: 'email', page: 0, logic: { enabled: true, action: 'hide', sourceBlockId: 'detractor', operator: 'not_answered' } },
    ],
  },
  {
    name: 'job_application',
    blocks: [
      { id: 'position', type: 'dropdown', page: 0, options: options('position', ['engineer', 'designer', 'manager']) },
      { id: 'portfolio', type: 'text', page: 0, logic: { enabled: true, action: 'show', sourceBlockId: 'position', operator: 'equals', value: 'designer' } },
      { id: 'years', type: 'number', page: 1 },
      { id: 'reference', type: 'text', page: 1, logic: { enabled: true, action: 'show', sourceBlockId: 'years', operator: 'greater_than', value: '5' } },
      { id: 'cover', type: 'long_text', page: 1, logic: { enabled: true, action: 'hide', sourceBlockId: 'portfolio', operator: 'contains', value: 'behance' } },
      { id: 'start', type: 'date', page: 2 },
    ],
  },
  {
    name: 'event_registration',
    blocks: [
      { id: 'attending', type: 'multiple_choice', page: 0, options: options('attending', ['yes', 'no', 'maybe']) },
      { id: 'diet', type: 'checkbox', page: 0, options: options('diet', ['veg', 'vegan', 'jain']), logic: { enabled: true, action: 'show', sourceBlockId: 'attending', operator: 'equals', value: 'yes' } },
      { id: 'guests', type: 'number', page: 1, logic: { enabled: true, action: 'hide', sourceBlockId: 'attending', operator: 'equals', value: 'no' } },
      { id: 'plus_one', type: 'text', page: 1, logic: { enabled: true, action: 'show', sourceBlockId: 'guests', operator: 'greater_than', value: '0' } },
      { id: 'jain_note', type: 'text', page: 1, logic: { enabled: true, action: 'show', sourceBlockId: 'diet', operator: 'equals', value: 'jain' } },
    ],
  },
];

const TYPES: readonly V1Type[] = ['text', 'long_text', 'email', 'number', 'multiple_choice', 'dropdown', 'checkbox', 'multi_select', 'rating', 'nps', 'date'];
const CHOICE: ReadonlySet<V1Type> = new Set(['multiple_choice', 'dropdown', 'checkbox', 'multi_select']);
const MULTI: ReadonlySet<V1Type> = new Set(['checkbox', 'multi_select']);
const NUMERIC: ReadonlySet<V1Type> = new Set(['number', 'rating', 'nps']);
const TEXTUAL: ReadonlySet<V1Type> = new Set(['text', 'long_text', 'email']);

const OPS = {
  text: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'answered', 'not_answered', 'is_empty'],
  numeric: ['equals', 'not_equals', 'greater_than', 'less_than', 'answered', 'not_answered'],
  other: ['equals', 'not_equals', 'answered', 'not_answered', 'is_empty'],
} as const satisfies Record<string, readonly V1Operator[]>;

const CHOICE_VALUES = ['red', 'blue', 'green', 'yes', 'no', 'maybe'];
const ANSWERS = {
  text: ['yes', 'no', 'Yes', '  yes ', 'maybe', 'Hello world', 'hello', 'Ünïcode', 'straße', 'ÉCOLE', 'école', 'Delhi', '42', '', '   '],
  email: ['asha@example.in', 'Ravi@Example.com', 'x@y.org'],
  number: ['0', '7', '42', '3.5', '-1', '100', '18'],
  date: ['2026-01-01', '2026-10-18', '2027-05-13'],
};
const TARGETS = {
  text: ['yes', 'hello', 'ELL', 'école', 'Delhi', '42', 'y', 'world', 'ünï'],
  email: ['example', 'asha@example.in', '.com', 'RAVI'],
  number: ['0', '7', '18', '3.5', '-1', '50'],
  rating: ['1', '3', '5'],
  nps: ['0', '6', '9'],
  date: ANSWERS.date,
};

function generated(index: number): V1Form {
  const r = rng(1000 + index);
  const count = 4 + r.int(7);
  const pages = 1 + r.int(3);
  const blocks: V1Block[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `b${index}_${i}`;
    const type = r.pick(TYPES);
    const block: V1Block = { id, type, page: Math.min(pages - 1, Math.floor((i * pages) / count)) };
    if (CHOICE.has(type)) {
      block.options = options(id, CHOICE_VALUES.slice(r.int(3)).slice(0, 2 + r.int(3)));
    }
    if (i > 0 && r.chance(0.7)) {
      const dangling = r.chance(0.05);
      const source = blocks[r.int(blocks.length)] as V1Block;
      const op: V1Operator = TEXTUAL.has(source.type) ? r.pick(OPS.text) : NUMERIC.has(source.type) ? r.pick(OPS.numeric) : r.pick(OPS.other);
      let value: string | undefined;
      if (CHOICE.has(source.type)) value = r.chance(0.1) ? 'unmatched' : r.pick(source.options ?? []).value;
      else if (source.type === 'email') value = r.pick(TARGETS.email);
      else if (TEXTUAL.has(source.type)) value = r.pick(TARGETS.text);
      else if (source.type === 'number') value = r.pick(TARGETS.number);
      else if (source.type === 'rating') value = r.pick(TARGETS.rating);
      else if (source.type === 'nps') value = r.pick(TARGETS.nps);
      else value = r.pick(TARGETS.date);
      block.logic = { enabled: true, action: r.chance(0.5) ? 'show' : 'hide', sourceBlockId: dangling ? `deleted_${id}` : source.id, operator: op };
      if (!['answered', 'not_answered', 'is_empty'].includes(op)) block.logic.value = value;
    }
    blocks.push(block);
  }
  return { name: `generated_${index + 1}`, blocks };
}

/** 35 v1 forms: the five templates and 30 seeded forms covering every operator, source type, chain and B21 case. */
export const V1_FORMS: readonly V1Form[] = [...TEMPLATES, ...Array.from({ length: 30 }, (_, i) => generated(i))];

/** `count` seeded v1 answer sets for a form; about a quarter of the fields stay unanswered. */
export function v1AnswerSets(f: V1Form, count: number, seed: number): V1Values[] {
  const r = rng(seed);
  return Array.from({ length: count }, () => {
    const values: V1Values = {};
    for (const b of f.blocks) {
      if (r.chance(0.25)) continue;
      if (MULTI.has(b.type)) values[b.id] = (b.options ?? []).filter(() => r.chance(0.4)).map((o) => o.value);
      else if (CHOICE.has(b.type)) values[b.id] = r.pick(b.options ?? []).value;
      else if (b.type === 'rating') values[b.id] = 1 + r.int(5);
      else if (b.type === 'nps') values[b.id] = r.int(11);
      else if (b.type === 'number') values[b.id] = r.pick(ANSWERS.number);
      else if (b.type === 'date') values[b.id] = r.pick(ANSWERS.date);
      else if (b.type === 'email') values[b.id] = r.pick(ANSWERS.email);
      else values[b.id] = r.pick(ANSWERS.text);
    }
    return values;
  });
}
