import type * as S from '@form/schema';
import {
  all, ans, any, bid, choices, cond, date, disable, enable, field, form, heading, hide, id, meta, nil, num, opts, page, requireIt, rule, show, text, time, unrequire,
} from '../build.ts';
import { rng } from './generate.ts';

/*
 * Random v2 forms in the P0 subset, for fuzzing and the incremental-evaluation property. Rules only read
 * blocks placed before their targets, and page targets only read earlier pages, so most forms compile;
 * the few with conflicting writers are skipped by the callers.
 */

type R = ReturnType<typeof rng>;
const TYPES = ['short_text', 'long_text', 'email', 'number', 'single_choice', 'multi_choice', 'date', 'time', 'rating', 'nps', 'linear_scale', 'ranking', 'hidden', 'heading'] as const;
type Kind = (typeof TYPES)[number];

const OPTION_IDS = ['a', 'b', 'c', 'd'];
const WORDS = ['yes', 'No', 'straße', 'ÉCOLE', 'नमस्ते', 'Delhi', 'x', '42'];
const NUMBERS = ['-1', '0', '0.5', '3', '7', '10', '42.25'];
const DATES = ['2026-01-01', '2026-10-18', '2027-05-13'];
const TIMES = ['00:00', '09:30', '17:45'];

function block(kind: Kind, blockId: string): S.Block {
  switch (kind) {
    case 'heading':
      return heading(blockId);
    case 'single_choice':
      return field('single_choice', blockId, { config: { display: 'radio', options: choices(...OPTION_IDS), other: { enabled: true, textRequired: false } } });
    case 'multi_choice':
      return field('multi_choice', blockId, { config: { display: 'checkbox', options: choices(...OPTION_IDS) } });
    case 'ranking':
      return field('ranking', blockId, { config: { options: choices(...OPTION_IDS) } });
    case 'hidden':
      return field('hidden', blockId, { config: { source: { kind: 'url_param', name: blockId } } });
    default:
      return field(kind, blockId) as S.FieldBlock;
  }
}

function leaf(r: R, source: S.StoredBlock): S.Condition {
  const left = ans(source.id);
  const presence = () => cond(left, r.pick(['is_answered', 'is_not_answered'] as const));
  switch (source.type) {
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'hidden':
    {
      if (r.chance(0.2)) return presence();
      const op = r.pick(['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with'] as const);
      return cond(left, op, (op === 'eq' || op === 'neq') && r.chance(0.2) ? nil() : text(r.pick(WORDS)), r.chance(0.3) ? { caseSensitive: true } : {});
    }
    case 'number':
    case 'rating':
    case 'nps':
    case 'linear_scale': {
      if (r.chance(0.2)) return presence();
      const op = r.pick(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'] as const);
      return cond(left, op, num(r.pick(NUMBERS)), op === 'between' ? { right2: num(r.pick(NUMBERS)) } : {});
    }
    case 'single_choice':
      if (r.chance(0.2)) return cond(ans(source.id, 'other'), 'contains', text('o'));
      return r.chance(0.2) ? presence() : cond(left, r.pick(['eq', 'neq', 'includes_any', 'includes_none'] as const), opts(source.id, ...OPTION_IDS.filter(() => r.chance(0.5))));
    case 'multi_choice': {
      if (r.chance(0.2)) return presence();
      const op = r.pick(['eq', 'neq', 'includes_any', 'includes_all', 'includes_none', 'count_eq', 'count_gte', 'count_lte'] as const);
      return cond(left, op, op.startsWith('count') ? num(String(r.int(4))) : opts(source.id, ...OPTION_IDS.filter(() => r.chance(0.5))));
    }
    case 'date': {
      if (r.chance(0.2)) return presence();
      const op = r.pick(['eq', 'neq', 'before', 'after', 'on_or_before', 'on_or_after', 'between'] as const);
      return cond(left, op, date(r.pick(DATES)), op === 'between' ? { right2: date(r.pick(DATES)) } : {});
    }
    case 'time':
      return r.chance(0.2) ? presence() : cond(left, r.pick(['eq', 'before', 'after', 'on_or_after'] as const), time(r.pick(TIMES)));
    default:
      return presence();
  }
}

function group(r: R, sources: readonly S.StoredBlock[], depth: number): S.ConditionGroup {
  const children: Array<S.Condition | S.ConditionGroup> = [];
  const n = r.int(4);
  for (let i = 0; i < n; i += 1) {
    if (depth < 3 && r.chance(0.2)) children.push(group(r, sources, depth + 1));
    else if (r.chance(0.1)) children.push(cond(meta('url_param', 'src'), 'eq', text('ad')));
    else children.push(leaf(r, r.pick(sources)));
  }
  const g = r.chance(0.5) ? all(...children) : any(...children);
  if (r.chance(0.15)) g.negate = true;
  return g;
}

export function randomForm(seed: number, size = { blocks: 12, pages: 3, rules: 10 }): S.FormDefinition {
  const r = rng(seed);
  const blocks: S.Block[] = [];
  const pageOf: number[] = [];
  for (let i = 0; i < size.blocks; i += 1) {
    const kind = i === 0 ? 'short_text' : r.pick(TYPES);
    const b = block(kind, `k${i}`);
    if (b.type !== 'heading' && b.type !== 'hidden' && r.chance(0.2)) (b as S.FieldBlock).required = true;
    if (r.chance(0.15)) b.initiallyHidden = true;
    if ('key' in b && b.type !== 'hidden' && r.chance(0.1)) b.initiallyDisabled = true;
    blocks.push(b);
    pageOf.push(Math.min(size.pages - 1, Math.floor((i * size.pages) / size.blocks)));
  }
  const values = (upTo: number) => blocks.slice(0, upTo).filter((b) => b.type !== 'heading');
  const rules: S.Rule[] = [];
  for (let i = 0; i < size.rules; i += 1) {
    const pageTarget = r.chance(0.1) && size.pages > 1;
    let reads: S.StoredBlock[];
    let targets: string[];
    if (pageTarget) {
      const p = 1 + r.int(size.pages - 1);
      reads = values(Math.max(0, pageOf.indexOf(p)));
      targets = [`p${p}`];
    } else {
      const t = 1 + r.int(size.blocks - 1);
      reads = values(t);
      targets = [`k${t}`];
      if (t + 1 < size.blocks && r.chance(0.3)) targets.push(`k${t + 1}`);
    }
    if (!reads.length) continue;
    const valueTargets = targets.filter((t) => t.startsWith('k') && blocks[Number(t.slice(1))]?.type !== 'heading');
    const action = (): S.Action => {
      const kind = valueTargets.length ? r.int(6) : r.int(2);
      return [show, hide, requireIt, unrequire, enable, disable][kind]!(...(kind < 2 ? targets : valueTargets));
    };
    rules.push(rule(`rule_${i}`, group(r, reads, 1), [action()], r.chance(0.4) ? [action()] : undefined, r.chance(0.05) ? { enabled: false } : {}));
  }
  const pages = Array.from({ length: size.pages }, (_, p) => page(`p${p}`, blocks.filter((_, i) => pageOf[i] === p).map((b) => b.id)));
  return form(blocks, pages, rules);
}

/** A valid answer for a block, or undefined (unanswered). */
export function randomAnswer(r: R, b: S.StoredBlock): S.AnswerValue | undefined {
  if (r.chance(0.3)) return undefined;
  switch (b.type) {
    case 'short_text':
    case 'long_text':
      return { type: b.type, value: r.pick(WORDS) };
    case 'email':
      return { type: 'email', value: { address: id<S.EmailAddress>(r.pick(['a@b.in', 'Yes@x.org'])) } };
    case 'number':
      return { type: 'number', value: id<S.DecimalString>(r.pick(NUMBERS)) };
    case 'single_choice':
      return r.chance(0.2) ? { type: 'single_choice', value: { optionId: null, other: r.pick(WORDS) } } : { type: 'single_choice', value: { optionId: id<S.OptionId>(r.pick(OPTION_IDS)) } };
    case 'multi_choice': {
      const picked = OPTION_IDS.filter(() => r.chance(0.4));
      return picked.length ? { type: 'multi_choice', value: { optionIds: picked.map((o) => id<S.OptionId>(o)) } } : undefined;
    }
    case 'ranking':
      return { type: 'ranking', value: OPTION_IDS.map((o) => id<S.OptionId>(o)) };
    case 'date':
      return { type: 'date', value: id<S.IsoDate>(r.pick(DATES)) };
    case 'time':
      return { type: 'time', value: { start: id<S.IsoTime>(r.pick(TIMES)) } };
    case 'rating':
      return { type: 'rating', value: 1 + r.int(5) };
    case 'nps':
      return { type: 'nps', value: r.int(11) };
    case 'linear_scale':
      return { type: 'linear_scale', value: 1 + r.int(5) };
    case 'hidden':
      return { type: 'hidden', value: r.pick(WORDS) };
    default:
      return undefined;
  }
}

export function randomAnswers(r: R, def: S.FormDefinition): S.Answers {
  const out: Partial<Record<S.BlockId, S.AnswerValue>> = {};
  for (const b of Object.values(def.blocks)) {
    if (!b) continue;
    const v = randomAnswer(r, b);
    if (v) out[bid(b.id)] = v;
  }
  return out;
}
