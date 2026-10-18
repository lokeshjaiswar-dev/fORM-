import type * as S from '@form/schema';
import { EN_IN, HI_IN, ans, bid, choices, field, form, id, inline, opts, page, pipe, rich, rule, v } from './build.ts';

/* Random form templates for the property tests (fast-check) and the determinism corpus (a seeded PRNG). */

export const KINDS = ['short_text', 'email', 'number', 'single_choice', 'date', 'long_text', 'heading', 'paragraph'] as const;

export interface RandomSpec {
  blocks: Array<(typeof KINDS)[number]>;
  /** 12 entries: a page break before block i. */
  pageBreaks: boolean[];
  /** The block after this one goes into a section placed right after it. */
  sectionAt: number | undefined;
  rules: Array<{ from: number; to: number; action: 'show' | 'hide' | 'require' | 'disable' }>;
  part: { blocks: number[]; rules: number[]; on: boolean };
  /** 12 entries: translate block i into hi-IN. */
  translate: boolean[];
}

export function build(s: RandomSpec): S.FormTemplatePayload {
  const ids = s.blocks.map((_, i) => `b${i}`);
  const blocks: S.StoredBlock[] = s.blocks.map((kind, i) => {
    const blockId = ids[i] ?? 'b';
    if (kind === 'heading') return { id: bid(blockId), type: 'heading', config: { level: 2, text: inline('Part ', v('custom.title', 'one')) } };
    if (kind === 'paragraph') return { id: bid(blockId), type: 'paragraph', config: { content: i > 0 ? rich('Hi ', pipe(ids[0] ?? 'b0')) : rich('Hi') } };
    if (kind === 'single_choice') return field('single_choice', blockId, { config: { display: 'radio', options: choices('x', 'y', 'z') } });
    return field(kind, blockId, { label: inline(`Q${i} for `, v('custom.title')) }) as S.StoredBlock;
  });
  const pages: S.Page[] = [page('p0', [])];
  const inSection = s.sectionAt !== undefined && s.sectionAt < ids.length - 1 ? s.sectionAt : undefined;
  ids.forEach((blockId, i) => {
    if (i > 0 && s.pageBreaks[i]) pages.push(page(`p${pages.length}`, []));
    if (inSection !== undefined && i === inSection + 1) return;
    pages.at(-1)?.children.push(bid(blockId));
  });
  if (inSection !== undefined) {
    const child = ids[inSection + 1] ?? '';
    blocks.push({ id: bid('sec'), type: 'section', config: { title: inline('Section'), children: [bid(child)], collapsible: false } });
    const host = pages.find((p) => p.children.includes(bid(ids[inSection] ?? '')));
    host?.children.splice(host.children.indexOf(bid(ids[inSection] ?? '')) + 1, 0, bid('sec'));
  }
  const pageOf = (blockId: string) => pages.findIndex((p) => p.children.includes(bid(blockId)) || (p.children.includes(bid('sec')) && blockId === ids[(inSection ?? -2) + 1]));
  const valueBlock = (i: number) => s.blocks[i] !== 'heading' && s.blocks[i] !== 'paragraph';
  const rules: S.Rule[] = [];
  s.rules.forEach((r, n) => {
    const from = r.from % ids.length;
    const to = r.to % ids.length;
    if (!valueBlock(from) || from === to || pageOf(ids[from] ?? '') > pageOf(ids[to] ?? '')) return;
    if ((r.action === 'require' || r.action === 'disable') && !valueBlock(to)) return;
    const left = ans(ids[from] ?? '');
    const when = { kind: 'group' as const, id: id<S.ConditionId>(`g${n}`), combinator: 'all' as const, children: [s.blocks[from] === 'single_choice'
      ? { kind: 'condition' as const, id: id<S.ConditionId>(`c${n}`), left, op: 'eq' as const, right: opts(ids[from] ?? '', 'y') }
      : { kind: 'condition' as const, id: id<S.ConditionId>(`c${n}`), left, op: 'is_answered' as const }] };
    const target = bid(ids[to] ?? '');
    const action: S.Action = r.action === 'show' || r.action === 'hide' ? { type: r.action, targets: [target] } : { type: r.action, targets: [target] };
    rules.push(rule(`r${n}`, when, [action]));
  });
  const document = form(blocks, pages, rules, { title: 'Random' });
  document.logic.variables = [{ id: id('v_score'), key: id('score'), name: 'Score', type: 'number', expr: { k: 'lit', value: { type: 'number', value: id('1') } }, persist: false }];
  if (rules[0]) {
    document.logic.ruleGroups = [{ id: id('grp'), name: 'Group' }];
    rules[0].groupId = id('grp');
  }
  document.i18n.locales.push({ locale: HI_IN, direction: 'ltr' });
  const messages: Partial<Record<S.TextKey, S.TranslationEntry>> = {};
  ids.forEach((blockId, i) => {
    if (s.translate[i] && valueBlock(i)) messages[`block:${blockId}:label`] = { value: inline('अनुवाद ', v('custom.title')), sourceHash: id('0'.repeat(64)), origin: 'human' };
    if (s.translate[i] && s.blocks[i] === 'single_choice') messages[`option:${blockId}/x`] = { value: 'एक्स', sourceHash: id('0'.repeat(64)), origin: 'human' };
  });
  rules.forEach((r) => {
    messages[`rule:${r.id}:0`] = { value: 'नियम', sourceHash: id('0'.repeat(64)), origin: 'human' };
  });
  document.i18n.messages[HI_IN] = messages;
  return {
    schemaVersion: 2,
    variables: [{ name: 'custom.title', source: 'prompt', type: 'text', label: 'Title', required: false, binding: 'bake' }, { name: 'custom.part', source: 'prompt', type: 'boolean', label: 'Part', required: false, default: true, binding: 'bake' }],
    locks: [],
    requiredFeatures: [],
    i18n: { defaultLocale: EN_IN, locales: [{ locale: EN_IN, direction: 'ltr' }], messages: {} },
    kind: 'form',
    document,
    dataInventory: [],
    estimatedMinutes: 1,
    optionalParts: [{
      id: id('part'), label: 'Part', when: { variable: 'custom.part', equals: s.part.on },
      includes: { blockSourceIds: s.part.blocks.filter((i) => i < ids.length).map((i) => ids[i] ?? ''), ruleSourceIds: s.part.rules.map((i) => `r${i}`) },
    }],
  };
}


/** mulberry32: a deterministic integer PRNG, the same in every engine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % 1000003;
  };
}

/** A RandomSpec drawn from `seed`. */
export function randomSpec(seed: number): RandomSpec {
  const next = prng(seed);
  const int = (n: number) => next() % n;
  const flags = () => Array.from({ length: 12 }, () => int(3) === 0);
  return {
    blocks: Array.from({ length: 2 + int(11) }, () => KINDS[int(KINDS.length)] ?? 'short_text'),
    pageBreaks: flags(),
    sectionAt: int(2) === 0 ? int(12) : undefined,
    rules: Array.from({ length: int(7) }, () => ({ from: int(12), to: int(12), action: (['show', 'hide', 'require', 'disable'] as const)[int(4)] ?? 'show' })),
    part: { blocks: [...new Set(Array.from({ length: int(4) }, () => int(12)))], rules: [...new Set(Array.from({ length: int(3) }, () => int(6)))], on: int(2) === 0 },
    translate: flags(),
  };
}
