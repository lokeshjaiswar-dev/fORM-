import { jsonPointer } from '@form/schema';
import type { Action, BlockId, FormDefinition, Rule, StoredBlock, TemplateOptionalPart, TemplateVariable, TemplateVariableName, TemplateWarning } from '@form/schema';
import { isOpaque, isRec, textKeyRef, type Rec } from './remap.ts';
import { mergeRuns } from './variables.ts';

type Answers = Partial<Record<TemplateVariableName, string | number | boolean>>;

/** A part is kept when its `when.variable` (the Use-dialog answer, else the declared default) equals `when.equals`. */
export function partIncluded(part: TemplateOptionalPart, answers: Answers, variables: readonly TemplateVariable[]): boolean {
  const value = answers[part.when.variable] ?? variables.find((v) => v.name === part.when.variable)?.default;
  return value === part.when.equals;
}

const childrenOf = (block: StoredBlock | undefined): readonly BlockId[] =>
  block && (block.type === 'section' || block.type === 'repeating_group') ? block.config.children : [];

/** Whether `value` refers to a removed block or variable through a `blockId` or `varId` (rules that do are dropped). */
function readsAny(value: unknown, blocks: ReadonlySet<string>, variables: ReadonlySet<string>): boolean {
  const stack: unknown[] = [value];
  for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
    if (Array.isArray(v)) {
      stack.push(...v);
      continue;
    }
    if (!isRec(v)) continue;
    if (typeof v['blockId'] === 'string' && blocks.has(v['blockId'])) return true;
    if (typeof v['varId'] === 'string' && variables.has(v['varId'])) return true;
    for (const [k, child] of Object.entries(v)) if (!isOpaque(v, k)) stack.push(child);
  }
  return false;
}

/** What the optional parts that are off removed: element ids (blocks, pages, endings) and logic-variable ids. */
export interface Removed { blocks: ReadonlySet<string>; variables: ReadonlySet<string> }

export const NOTHING_REMOVED: Removed = { blocks: new Set(), variables: new Set() };

const removedRef = (v: unknown, gone: ReadonlySet<string>, goneVars: ReadonlySet<string>): boolean =>
  isRec(v) && ((v['kind'] === 'answer' && typeof v['blockId'] === 'string' && gone.has(v['blockId'])) || (v['kind'] === 'variable' && typeof v['varId'] === 'string' && goneVars.has(v['varId'])));

const fieldOn = (v: unknown, gone: ReadonlySet<string>): boolean => isRec(v) && v['kind'] === 'field' && typeof v['blockId'] === 'string' && gone.has(v['blockId']);

/** Optional references that are dropped with their target. */
const OPTIONAL_REFS: ReadonlySet<string> = new Set(['anchorBlockId', 'evidenceUploadBlockId']);
/** Reference keys checked for what is left pointing at a removed item (the element keys `remapRefs` maps, and `varId`). */
const REF_KEYS = /^(blockIds?|target|targets|children|atPage|pageId|endingId|defaultEndingId|repeatingGroupId|varId|[a-z][A-Za-z]*BlockIds?)$/;

/**
 * Content (a definition, or a ref payload applied with it) with what pointed at a removed block or variable
 * pruned: a pipe becomes its fallback text (or goes), a field recipient goes (an approver becomes the form
 * owner), a date bound, an optional anchor, a PDF password source, a reply-to and an answers-table entry on
 * a removed field go, and a workflow branch that reads one goes. A required reference that cannot be pruned
 * (an age gate's date-of-birth field) stays and is reported as `part_removed_rule` at `base` + its pointer,
 * as is each branch or approver that was changed and each recipient list left empty. Opaque payloads are left
 * alone. Works on template source ids.
 */
export function pruneRemoved<T>(value: T, removed: Removed, base: string, warnings: TemplateWarning[]): T {
  const { blocks: gone, variables: goneVars } = removed;
  if (!gone.size && !goneVars.size) return value;
  const isGone = (key: string, id: unknown) => typeof id === 'string' && (key === 'varId' ? goneVars : gone).has(id);
  const report = (message: string, at: string) => warnings.push({ code: 'part_removed_rule', message, at });
  const walk = (v: unknown, path: string, parentKey: string | null): unknown => {
    if (Array.isArray(v)) {
      let merge = false;
      let recipients = false;
      const items = v.flatMap((item: unknown, i) => {
        if (isRec(item) && item['type'] === 'pipe' && isRec(item['attrs']) && removedRef(item['attrs']['source'], gone, goneVars)) {
          merge = true;
          const fallback = item['attrs']['fallback'];
          return typeof fallback === 'string' && fallback ? [{ type: 'text', text: fallback }] : [];
        }
        if (isRec(item) && Object.keys(item).length === 1 && isRec(item['pipe']) && removedRef(item['pipe']['source'], gone, goneVars)) {
          merge = true;
          const fallback = item['pipe']['fallback'];
          return typeof fallback === 'string' && fallback ? [fallback] : [];
        }
        if (fieldOn(item, gone)) {
          recipients = true;
          return [];
        }
        if (parentKey === 'branches' && isRec(item) && readsAny(item['when'], gone, goneVars)) {
          report('A workflow branch was removed with an optional part it reads', `${path}/${i}`);
          return [];
        }
        if (typeof item === 'string' && parentKey !== null && /^(blockIds|[a-z][A-Za-z]*BlockIds)$/.test(parentKey) && gone.has(item)) return [];
        return [walk(item, `${path}/${i}`, parentKey)];
      });
      if (recipients && !items.length) report('No recipient is left: an optional part removed the field it was sent to', path);
      return merge ? mergeRuns(items) : items;
    }
    if (!isRec(v)) return v;
    const out: Rec = {};
    for (const [k, child] of Object.entries(v)) {
      const at = `${path}/${jsonPointer(k).slice(1)}`;
      if (isOpaque(v, k)) out[k] = child;
      else if ((k === 'min' || k === 'max' || k === 'replyTo') && fieldOn(child, gone)) continue;
      else if (k === 'approver' && fieldOn(child, gone)) {
        out[k] = { kind: 'role', role: 'form_owner' };
        report('An approver field was removed with an optional part; the form owner approves instead', at);
      } else if (OPTIONAL_REFS.has(k) && isGone(k, child)) continue;
      else if (parentKey === 'billing' && isGone(k, child)) continue;
      else if (k === 'pageId' && 'guardianEmailBlockId' in v && isGone(k, child)) continue;
      else if ((k === 'passwordFrom' && isRec(child) && isGone('blockId', child['blockId'])) || (k === 'password' && isRec(child) && isGone('blockId', child['fromBlockId']))) continue;
      else out[k] = walk(child, at, k);
    }
    if (v['type'] === 'answersTable' && isRec(out['attrs']) && Array.isArray(out['attrs']['include'])) {
      out['attrs'] = { ...out['attrs'], include: out['attrs']['include'].filter((b: unknown) => !isGone('blockId', b)) };
    }
    for (const [k, child] of Object.entries(out)) {
      if (!REF_KEYS.test(k) || isOpaque(v, k)) continue;
      for (const id of Array.isArray(child) ? child : [child]) {
        if (isGone(k, id)) report(`'${k}' still refers to '${String(id)}', which an optional part removed`, `${path}/${jsonPointer(k).slice(1)}`);
      }
    }
    return out;
  };
  return walk(value, base, null) as T;
}

/** An action with its removed targets dropped, or null when nothing is left for it to act on. */
function pruneAction(action: Action, gone: ReadonlySet<string>, goneVars: ReadonlySet<string>): Action | null {
  switch (action.type) {
    case 'show':
    case 'hide': {
      const targets = action.targets.filter((t) => !gone.has(t));
      return targets.length ? { ...action, targets } : null;
    }
    case 'require':
    case 'unrequire':
    case 'enable':
    case 'disable':
    case 'clear_value': {
      const targets = action.targets.filter((t) => !gone.has(t));
      return targets.length ? { ...action, targets } : null;
    }
    case 'set_value':
    case 'show_options':
    case 'hide_options':
      return gone.has(action.target) || readsAny(action, gone, goneVars) ? null : action;
    case 'set_variable':
      return goneVars.has(action.varId) || readsAny(action.value, gone, goneVars) ? null : action;
    case 'skip_to_page':
      return gone.has(action.from) || gone.has(action.to) ? null : action;
    case 'skip_to_end':
      return gone.has(action.from) || (action.endingId !== undefined && gone.has(action.endingId)) ? null : action;
    case 'set_ending':
      return gone.has(action.endingId) ? null : action;
    case 'block_submit': {
      if (action.atPage !== undefined && gone.has(action.atPage)) return null;
      if (action.anchorBlockId !== undefined && gone.has(action.anchorBlockId)) {
        const { anchorBlockId: _dropped, ...rest } = action;
        return rest;
      }
      return action;
    }
    case 'route_email': {
      const recipients = action.recipients.filter((r) => r.kind !== 'field' || !gone.has(r.blockId));
      return recipients.length ? { ...action, recipients } : null;
    }
    default:
      return readsAny(action, gone, goneVars) ? null : action;
  }
}

/**
 * Removes every optional part whose condition is false, with everything it lists (templates spec §3.1 step 4):
 * blocks (with their descendants), pages (with the blocks on them), rules, variables, endings and purposes,
 * then the references to them. A kept rule that reads a removed block or variable, or is left with no
 * action, is removed too and reported as `part_removed_rule`; the rest is pruned by `pruneRemoved`. `removed`
 * lists what went, for the refs applied with the definition. Works on template source ids.
 */
export function applyOptionalParts(
  def: FormDefinition, parts: readonly TemplateOptionalPart[], answers: Answers, variables: readonly TemplateVariable[],
): { definition: FormDefinition; warnings: TemplateWarning[]; removed: Removed } {
  const removed = parts.filter((p) => !partIncluded(p, answers, variables));
  if (!removed.length) return { definition: def, warnings: [], removed: NOTHING_REMOVED };
  const gone = new Set<string>();
  const goneRules = new Set<string>();
  const goneVars = new Set<string>();
  const gonePurposes = new Set<string>();
  const dropBlock = (id: string) => {
    if (gone.has(id)) return;
    gone.add(id);
    childrenOf(def.blocks[id as BlockId]).forEach(dropBlock);
  };
  for (const { includes } of removed) {
    includes.blockSourceIds?.forEach(dropBlock);
    for (const pageId of includes.pageSourceIds ?? []) {
      gone.add(pageId);
      def.pages.find((p) => p.id === pageId)?.children.forEach(dropBlock);
    }
    includes.endingSourceIds?.forEach((id) => gone.add(id));
    includes.ruleSourceIds?.forEach((id) => goneRules.add(id));
    includes.variableSourceIds?.forEach((id) => goneVars.add(id));
    includes.purposeSourceIds?.forEach((id) => gonePurposes.add(id));
  }
  /* A form keeps at least one ending: when the parts would remove them all, they stay. */
  if (def.endings.every((e) => gone.has(e.id))) def.endings.forEach((e) => gone.delete(e.id));

  const warnings: TemplateWarning[] = [];
  const rules: Rule[] = [];
  def.logic.rules.forEach((rule, i) => {
    if (goneRules.has(rule.id)) return;
    const then = rule.then.map((a) => pruneAction(a, gone, goneVars)).filter((a): a is Action => a !== null);
    const otherwise = rule.else?.map((a) => pruneAction(a, gone, goneVars)).filter((a): a is Action => a !== null);
    const reads = readsAny(rule.when, gone, goneVars) || (rule.scope !== undefined && gone.has(rule.scope.repeatingGroupId));
    if (reads || (then.length === 0 && !otherwise?.length)) {
      warnings.push({ code: 'part_removed_rule', message: `Rule '${rule.name ?? rule.id}' was removed with an optional part it depends on`, at: `/logic/rules/${i}` });
      return;
    }
    const { else: _else, ...rest } = rule;
    rules.push(otherwise?.length ? { ...rest, then, else: otherwise } : { ...rest, then });
  });

  const keep = (id: string) => !gone.has(id);
  const blocks: FormDefinition['blocks'] = {};
  for (const [id, block] of Object.entries(def.blocks)) {
    if (!block || gone.has(id)) continue;
    let next: StoredBlock = block;
    if (next.type === 'section' || next.type === 'repeating_group') next = { ...next, config: { ...next.config, children: next.config.children.filter(keep) } } as StoredBlock;
    if (next.type === 'consent') next = { ...next, config: { ...next.config, items: next.config.items.filter((item) => item.purposeId === undefined || !gonePurposes.has(item.purposeId)) } };
    if ('compliance' in next) next = { ...next, compliance: { ...next.compliance, purposeIds: next.compliance.purposeIds.filter((p) => !gonePurposes.has(p)) } } as StoredBlock;
    blocks[id as BlockId] = next;
  }
  const endings = def.endings.filter((e) => keep(e.id));
  const pages = def.pages.filter((p) => keep(p.id)).map((p) => ({ ...p, children: p.children.filter(keep) }));
  const messages: FormDefinition['i18n']['messages'] = {};
  for (const [locale, entries] of Object.entries(def.i18n.messages)) {
    const kept = Object.entries(entries ?? {}).filter(([key]) => {
      const ref = textKeyRef(key);
      if (!ref) return true;
      if (ref.ns === 'element') return !gone.has(ref.id);
      if (ref.ns === 'rule') return rules.some((r) => r.id === ref.id);
      if (ref.ns === 'purpose') return !gonePurposes.has(ref.id);
      return true;
    });
    messages[locale as keyof typeof messages] = Object.fromEntries(kept);
  }
  const removedIds: Removed = { blocks: gone, variables: goneVars };
  const definition: FormDefinition = pruneRemoved({
    ...def,
    blocks,
    pages,
    endings,
    defaultEndingId: endings.some((e) => e.id === def.defaultEndingId) || !endings[0] ? def.defaultEndingId : endings[0].id,
    logic: { ...def.logic, rules, variables: def.logic.variables.filter((v) => !goneVars.has(v.id)) },
    privacy: { ...def.privacy, purposes: def.privacy.purposes.filter((p) => !gonePurposes.has(p.id)) },
    i18n: { ...def.i18n, messages },
  }, removedIds, '', warnings);
  return { definition, warnings, removed: removedIds };
}
