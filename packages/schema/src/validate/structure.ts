import type { PublishIssue, StoredBlock } from '../v2/blocks.ts';
import type { FieldCompliance } from '../v2/compliance.ts';
import type { FormDefinition } from '../v2/definition.ts';
import type { ClientAction, ServerAction } from '../v2/logic.ts';
import { VALUE_FIELD_TYPES } from '../v2/zod/catalogue.ts';
import { isSafeHref, isSafeUrl } from '../v2/zod/primitives.ts';
import { InlineDocSchema, RichDocSchema } from '../v2/zod/rich-text.ts';

/**
 * Structural invariants of a v2 definition that one zod parse cannot see: I1 (one id namespace
 * for blocks, pages and endings; unique ids per parent and per logic list), I3 (unique FieldKey),
 * I4 (every id reference resolves), I5/I6 (rich-text AST, link schemes, alt text), I7 (compliance
 * on value blocks), I12 (each block placed once, child lists without repeats) and I14 (a dpdp
 * consent block precedes the fields that rely on consent).
 *
 * Duplicates are always errors. Dangling references, missing purposes, missing alt text, unsupported
 * blocks and I14 are warnings while a draft is being edited ('save') and errors at 'publish'.
 * Opaque payloads (an unsupported block's `raw`, `x-*` extensions) are not inspected.
 */
export interface StructureOptions { mode?: 'save' | 'publish' }

type Code = PublishIssue['code'];
type Rec = Record<string, unknown>;

const VALUE_TYPES: ReadonlySet<string> = new Set(VALUE_FIELD_TYPES);
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;
const token = (part: string | number) => String(part).replace(/~/g, '~0').replace(/\//g, '~1');
export const jsonPointer = (...parts: Array<string | number>): string => parts.map((p) => `/${token(p)}`).join('');

/** Opaque payloads the schema does not describe: an unsupported block's `raw` and `x-*` extensions. */
const isOpaque = (parent: Rec, key: string) => key.startsWith('x-') || (key === 'raw' && parent['type'] === 'unsupported');

/** Visits every object and array under `root` without recursion, with its JSON pointer, skipping opaque payloads. */
function walk(root: unknown, base: string, visit: (node: Rec, path: string) => void): void {
  const stack: Array<[unknown, string]> = [[root, base]];
  for (let item = stack.pop(); item; item = stack.pop()) {
    const [node, path] = item;
    if (!isRec(node)) continue;
    visit(node, path);
    const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node).filter(([key]) => !isOpaque(node, key));
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry) stack.push([entry[1], `${path}/${token(entry[0])}`]);
    }
  }
}

function optionIdsOf(block: StoredBlock | undefined): ReadonlySet<string> | null {
  if (!block) return null;
  switch (block.type) {
    case 'single_choice':
    case 'multi_choice':
    case 'ranking':
      return new Set(block.config.options.map((o) => o.id));
    default:
      return null;
  }
}

function childIdsOf(block: StoredBlock): readonly string[] {
  return block.type === 'section' || block.type === 'repeating_group' ? block.config.children : [];
}

export function validateStructure(def: FormDefinition, options: StructureOptions = {}): PublishIssue[] {
  const mode = options.mode ?? 'save';
  const issues: PublishIssue[] = [];
  const error = (code: Code, path: string, message: string) => issues.push({ severity: 'error', code, path, message });
  const soft = (code: Code, path: string, message: string) => issues.push({ severity: mode === 'publish' ? 'error' : 'warning', code, path, message });

  /* I1: blocks, pages and endings share one id namespace. Blocks of a type this reader does not know never publish. */
  const blocks = new Map<string, StoredBlock>();
  for (const [key, block] of Object.entries(def.blocks)) {
    if (!block) continue;
    if (block.id !== key) error('duplicate_id', jsonPointer('blocks', key, 'id'), `block id '${block.id}' differs from its key '${key}'`);
    if (block.type === 'unsupported') soft('unknown_block_type', jsonPointer('blocks', key), `block type '${block.originalType}' is not supported by this version`);
    blocks.set(key, block);
  }
  const elements = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const first = elements.get(id);
    if (first === undefined) elements.set(id, path);
    else error('duplicate_id', path, `id '${id}' is already used at ${first}`);
  };
  for (const key of blocks.keys()) claim(key, jsonPointer('blocks', key));
  def.pages.forEach((page, i) => claim(page.id, jsonPointer('pages', i, 'id')));
  def.endings.forEach((ending, i) => claim(ending.id, jsonPointer('endings', i, 'id')));
  const pageIds = new Set(def.pages.map((p) => p.id as string));
  const endingIds = new Set(def.endings.map((e) => e.id as string));

  const unique = (ids: readonly string[], path: (i: number) => string, what: string) => {
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) error('duplicate_id', path(i), `duplicate ${what} id '${id}'`);
      seen.add(id);
    });
  };
  unique(def.logic.rules.map((r) => r.id), (i) => jsonPointer('logic', 'rules', i, 'id'), 'rule');
  unique(def.logic.ruleGroups.map((g) => g.id), (i) => jsonPointer('logic', 'ruleGroups', i, 'id'), 'rule group');
  unique(def.logic.variables.map((v) => v.id), (i) => jsonPointer('logic', 'variables', i, 'id'), 'variable');
  unique(def.privacy.purposes.map((p) => p.id), (i) => jsonPointer('privacy', 'purposes', i, 'id'), 'purpose');
  for (const [key, block] of blocks) {
    const at = (...rest: Array<string | number>) => jsonPointer('blocks', key, 'config', ...rest);
    switch (block.type) {
      case 'single_choice':
      case 'multi_choice':
      case 'ranking':
        unique(block.config.options.map((o) => o.id), (i) => at('options', i, 'id'), 'option');
        break;
      case 'matrix':
        unique(block.config.rows.map((r) => r.id), (i) => at('rows', i, 'id'), 'matrix row');
        unique(block.config.columns.map((c) => c.id), (i) => at('columns', i, 'id'), 'matrix column');
        block.config.columns.forEach((c, ci) => {
          if (c.input === 'dropdown') unique(c.options.map((o) => o.id), (i) => at('columns', ci, 'options', i, 'id'), 'option');
        });
        break;
      case 'consent':
        unique(block.config.items.map((item) => item.id), (i) => at('items', i, 'id'), 'consent item');
        break;
      case 'payment':
        if (block.config.amount.kind === 'products') {
          const products = block.config.amount.products;
          unique(products.map((p) => p.id), (i) => at('amount', 'products', i, 'id'), 'product');
          products.forEach((p, pi) => {
            unique((p.options ?? []).map((o) => o.id), (i) => at('amount', 'products', pi, 'options', i, 'id'), 'product option');
            (p.options ?? []).forEach((o, oi) => unique(o.choices.map((c) => c.id), (i) => at('amount', 'products', pi, 'options', oi, 'choices', i, 'id'), 'option'));
          });
        }
        break;
      default:
        break;
    }
  }

  /* I3: one FieldKey per value block and logic variable. */
  const keys = new Map<string, string>();
  const claimKey = (key: string, path: string) => {
    const first = keys.get(key);
    if (first === undefined) keys.set(key, path);
    else error('duplicate_key', path, `key '${key}' is already used at ${first}`);
  };
  for (const [id, block] of blocks) if ('key' in block) claimKey(block.key, jsonPointer('blocks', id, 'key'));
  def.logic.variables.forEach((v, i) => claimKey(v.key, jsonPointer('logic', 'variables', i, 'key')));

  /* I4 + I12: placement, document order and references. */
  const block = (id: string, path: string) => {
    if (!blocks.has(id)) soft('dangling_ref', path, `block '${id}' does not exist`);
  };
  const page = (id: string, path: string) => {
    if (!pageIds.has(id)) soft('dangling_ref', path, `page '${id}' does not exist`);
  };
  const ending = (id: string, path: string) => {
    if (!endingIds.has(id)) soft('dangling_ref', path, `ending '${id}' does not exist`);
  };
  const variableIds = new Set(def.logic.variables.map((v) => v.id as string));
  const purposeIds = new Set(def.privacy.purposes.map((p) => p.id as string));
  const purpose = (id: string, path: string) => {
    if (!purposeIds.has(id)) soft('dangling_ref', path, `purpose '${id}' does not exist`);
  };
  const optionsOf = (blockId: string, ids: readonly string[], path: string) => {
    const known = optionIdsOf(blocks.get(blockId));
    if (!known) return;
    ids.forEach((o, i) => {
      if (!known.has(o)) soft('dangling_ref', `${path}/${i}`, `option '${o}' is not an option of block '${blockId}'`);
    });
  };

  /* Pre-order, depth first: a section's children come before the section's next sibling, as rendered. */
  const placedAt = new Map<string, string>();
  const documentOrder: string[] = [];
  def.pages.forEach((p, pageIndex) => {
    const frames: Array<{ ids: readonly string[]; path: string; next: number; seen: Set<string> }> = [
      { ids: p.children, path: jsonPointer('pages', pageIndex, 'children'), next: 0, seen: new Set() },
    ];
    for (let frame = frames.at(-1); frame; frame = frames.at(-1)) {
      if (frame.next >= frame.ids.length) {
        frames.pop();
        continue;
      }
      const i = frame.next;
      frame.next += 1;
      const id = frame.ids[i] ?? '';
      const at = `${frame.path}/${i}`;
      if (frame.seen.has(id)) {
        error('duplicate_id', at, `block '${id}' is listed twice`);
        continue;
      }
      frame.seen.add(id);
      const child = blocks.get(id);
      if (!child) {
        block(id, at);
        continue;
      }
      const first = placedAt.get(id);
      if (first !== undefined) {
        error('duplicate_id', at, `block '${id}' is already placed at ${first}`);
        continue;
      }
      placedAt.set(id, at);
      documentOrder.push(id);
      const grandChildren = childIdsOf(child);
      if (grandChildren.length) frames.push({ ids: grandChildren, path: jsonPointer('blocks', id, 'config', 'children'), next: 0, seen: new Set() });
    }
  });
  for (const id of blocks.keys()) {
    if (!placedAt.has(id)) issues.push({ severity: 'warning', code: 'dangling_ref', path: jsonPointer('blocks', id), message: `block '${id}' is not placed on any page` });
  }
  ending(def.defaultEndingId, jsonPointer('defaultEndingId'));

  const groupIds = new Set(def.logic.ruleGroups.map((g) => g.id as string));
  const checkAction = (action: ClientAction | ServerAction, path: string) => {
    switch (action.type) {
      case 'show':
      case 'hide':
        action.targets.forEach((t, i) => {
          if (!blocks.has(t) && !pageIds.has(t)) soft('dangling_ref', `${path}/targets/${i}`, `'${t}' is neither a block nor a page`);
        });
        break;
      case 'require':
      case 'unrequire':
      case 'enable':
      case 'disable':
      case 'clear_value':
        action.targets.forEach((t, i) => block(t, `${path}/targets/${i}`));
        break;
      case 'set_value':
        block(action.target, `${path}/target`);
        break;
      case 'set_variable':
        if (!variableIds.has(action.varId)) soft('dangling_ref', `${path}/varId`, `variable '${action.varId}' does not exist`);
        break;
      case 'skip_to_page':
        page(action.from, `${path}/from`);
        page(action.to, `${path}/to`);
        break;
      case 'skip_to_end':
        page(action.from, `${path}/from`);
        if (action.endingId !== undefined) ending(action.endingId, `${path}/endingId`);
        break;
      case 'set_ending':
        ending(action.endingId, `${path}/endingId`);
        break;
      case 'block_submit':
        if (action.atPage !== undefined) page(action.atPage, `${path}/atPage`);
        if (action.anchorBlockId !== undefined) block(action.anchorBlockId, `${path}/anchorBlockId`);
        break;
      case 'show_options':
      case 'hide_options':
        block(action.target, `${path}/target`);
        optionsOf(action.target, action.optionIds, `${path}/optionIds`);
        break;
      default:
        break;
    }
  };
  def.logic.rules.forEach((rule, i) => {
    const at = jsonPointer('logic', 'rules', i);
    if (rule.groupId !== undefined && !groupIds.has(rule.groupId)) soft('dangling_ref', `${at}/groupId`, `rule group '${rule.groupId}' does not exist`);
    if (rule.scope) {
      const group = blocks.get(rule.scope.repeatingGroupId);
      if (group?.type !== 'repeating_group') soft('dangling_ref', `${at}/scope/repeatingGroupId`, `'${rule.scope.repeatingGroupId}' is not a repeating group`);
    }
    rule.then.forEach((a, j) => checkAction(a, `${at}/then/${j}`));
    rule.else?.forEach((a, j) => checkAction(a, `${at}/else/${j}`));
  });

  for (const [id, b] of blocks) {
    const at = (...rest: Array<string | number>) => jsonPointer('blocks', id, ...rest);
    switch (b.type) {
      case 'single_choice':
        if (b.config.defaultOptionId !== undefined) optionsOf(id, [b.config.defaultOptionId], at('config', 'defaultOptionId'));
        break;
      case 'multi_choice':
        optionsOf(id, b.config.defaultOptionIds ?? [], at('config', 'defaultOptionIds'));
        optionsOf(id, b.config.exclusiveOptionIds ?? [], at('config', 'exclusiveOptionIds'));
        break;
      case 'consent':
        b.config.items.forEach((item, i) => {
          if (item.purposeId !== undefined) purpose(item.purposeId, at('config', 'items', i, 'purposeId'));
        });
        break;
      case 'payment': {
        const { billing, tax } = b.config;
        for (const [k, v] of Object.entries(billing ?? {})) if (v !== undefined) block(v, at('config', 'billing', k));
        if (tax?.gst) block(tax.gst.placeOfSupplyBlockId, at('config', 'tax', 'gst', 'placeOfSupplyBlockId'));
        tax?.byLocation?.forEach((l, i) => block(l.locationBlockId, at('config', 'tax', 'byLocation', i, 'locationBlockId')));
        break;
      }
      case 'appointment':
        b.config.reminders?.forEach((r, i) => block(r.emailBlockId, at('config', 'reminders', i, 'emailBlockId')));
        break;
      default:
        break;
    }
  }

  const children = def.privacy.children;
  const guardian = children.mode === 'age_gate' ? (children.underAge.kind === 'parental_consent' ? children.underAge.guardian : null)
    : children.mode === 'lawful_guardian' ? children.guardian : null;
  if (children.mode === 'age_gate') block(children.dobBlockId, jsonPointer('privacy', 'children', 'dobBlockId'));
  if (children.mode === 'lawful_guardian') block(children.guardianshipEvidenceBlockId, jsonPointer('privacy', 'children', 'guardianshipEvidenceBlockId'));
  if (guardian) {
    const base = children.mode === 'age_gate' ? ['privacy', 'children', 'underAge', 'guardian'] : ['privacy', 'children', 'guardian'];
    block(guardian.guardianEmailBlockId, jsonPointer(...base, 'guardianEmailBlockId'));
    if (guardian.evidenceUploadBlockId !== undefined) block(guardian.evidenceUploadBlockId, jsonPointer(...base, 'evidenceUploadBlockId'));
    if (guardian.pageId !== undefined) page(guardian.pageId, jsonPointer(...base, 'pageId'));
  }
  if (def.behavior.analytics) purpose(def.behavior.analytics.requiresPurposeId, jsonPointer('behavior', 'analytics', 'requiresPurposeId'));

  /* Generic value references (answers, DateBound fields, recipients, typed option operands, variables) and rich docs. */
  const conditionIds = new Map<string, string>();
  const docs: Array<[Rec, string]> = [];
  walk(def, '', (node, path) => {
    const kind = node['kind'];
    if ((kind === 'answer' || kind === 'field' || kind === 'options') && typeof node['blockId'] === 'string') {
      block(node['blockId'], `${path}/blockId`);
      if (kind === 'options' && Array.isArray(node['optionIds'])) optionsOf(node['blockId'], node['optionIds'].filter((o): o is string => typeof o === 'string'), `${path}/optionIds`);
    }
    if (kind === 'variable' && typeof node['varId'] === 'string' && !variableIds.has(node['varId'])) {
      soft('dangling_ref', `${path}/varId`, `variable '${node['varId']}' does not exist`);
    }
    if ((kind === 'condition' || kind === 'group') && typeof node['id'] === 'string') {
      const first = conditionIds.get(node['id']);
      if (first === undefined) conditionIds.set(node['id'], path);
      else error('duplicate_id', `${path}/id`, `condition id '${node['id']}' is already used at ${first}`);
    }
    if (node['type'] === 'doc' && Array.isArray(node['content'])) docs.push([node, path]);
  });

  /* I5/I6: rich text. Inline-only locations must hold exactly one paragraph. */
  const inlinePaths = new Set<string>();
  /* The TextKey of each inline source, so its translations are held to the same single-paragraph rule. */
  const inlineKeys = new Set<string>();
  const inlineAt = (key: string, ...path: Array<string | number>) => {
    inlinePaths.add(jsonPointer(...path));
    inlineKeys.add(key);
  };
  for (const [id, b] of blocks) {
    if ('key' in b) inlineAt(`block:${id}:label`, 'blocks', id, 'label');
    if (b.type === 'heading') {
      inlineAt(`block:${id}:text`, 'blocks', id, 'config', 'text');
      inlineAt(`block:${id}:subheading`, 'blocks', id, 'config', 'subheading');
    }
    if (b.type === 'section') inlineAt(`block:${id}:title`, 'blocks', id, 'config', 'title');
    if (b.type === 'signature') inlineAt(`block:${id}:statement`, 'blocks', id, 'config', 'statement');
    if (b.type === 'consent') {
      inlineAt(`consent:${id}:withdrawal`, 'blocks', id, 'config', 'withdrawalText');
      b.config.items.forEach((item, i) => inlineAt(`consent:${id}:item:${item.id}`, 'blocks', id, 'config', 'items', i, 'label'));
    }
  }
  def.privacy.purposes.forEach((p, i) => inlineAt(`purpose:${p.id}:description`, 'privacy', 'purposes', i, 'description'));
  for (const [locale, entries] of Object.entries(def.i18n.messages)) {
    for (const key of Object.keys(entries ?? {})) {
      if (inlineKeys.has(key)) inlinePaths.add(jsonPointer('i18n', 'messages', locale, key, 'value'));
    }
  }

  for (const [doc, path] of docs) {
    let badLinks = 0;
    walk(doc, path, (node, at) => {
      if (node['type'] === 'link' && isRec(node['attrs'])) {
        const href = node['attrs']['href'];
        if (typeof href !== 'string' || !isSafeHref(href)) {
          badLinks += 1;
          error('invalid_url_scheme', `${at}/attrs/href`, 'links may only use https, http, mailto or tel');
        }
      }
      if (node['type'] === 'image' && isRec(node['attrs'])) {
        const { href, asset } = node['attrs'];
        if (href !== undefined && (typeof href !== 'string' || !isSafeUrl(href))) {
          badLinks += 1;
          error('invalid_url_scheme', `${at}/attrs/href`, 'image links may only use https or http');
        }
        if (isRec(asset) && 'assetId' in asset && asset['decorative'] !== true && !(typeof asset['alt'] === 'string' && asset['alt'].trim())) {
          soft('missing_alt_text', `${at}/attrs/asset`, 'content images need alt text unless marked decorative');
        }
      }
    });
    const parsed = (inlinePaths.has(path) ? InlineDocSchema : RichDocSchema).safeParse(doc);
    if (!parsed.success) {
      const other = parsed.error.issues.filter((iss) => iss.path[iss.path.length - 1] !== 'href');
      if (other.length || !badLinks) error('invalid_rich_text', path, other[0]?.message ?? parsed.error.issues[0]?.message ?? 'invalid rich text');
    }
  }
  for (const [id, b] of blocks) {
    if (b.type === 'image') {
      const { image, href } = b.config;
      if (href !== undefined && !isSafeUrl(href)) error('invalid_url_scheme', jsonPointer('blocks', id, 'config', 'href'), 'image links may only use https or http');
      if ('assetId' in image && image.decorative !== true && !image.alt?.trim()) {
        soft('missing_alt_text', jsonPointer('blocks', id, 'config', 'image'), 'content images need alt text unless marked decorative');
      }
    }
  }

  /* I7: every value block declares compliance, with purposes unless classified 'none'. */
  for (const [id, b] of blocks) {
    if (!VALUE_TYPES.has(b.type)) continue;
    const at = jsonPointer('blocks', id, 'compliance');
    const compliance = (b as { compliance?: FieldCompliance }).compliance;
    if (!compliance) {
      error('missing_purpose', at, 'value blocks must declare compliance');
      continue;
    }
    if (compliance.classification !== 'none' && compliance.purposeIds.length === 0) {
      soft('missing_purpose', `${at}/purposeIds`, `a '${compliance.classification}' field needs at least one purpose`);
    }
    compliance.purposeIds.forEach((p, i) => purpose(p, `${at}/purposeIds/${i}`));
  }

  /* I14: the first dpdp consent block comes before every field whose purposes rely on consent. */
  const consentPurposes = new Set(def.privacy.purposes.filter((p) => p.lawfulBasis.kind === 'consent').map((p) => p.id as string));
  const consentAt = documentOrder.findIndex((id) => {
    const b = blocks.get(id);
    return b?.type === 'consent' && b.config.mode === 'dpdp';
  });
  if (consentAt >= 0 && consentPurposes.size) {
    const consentId = documentOrder[consentAt] ?? '';
    documentOrder.slice(0, consentAt).forEach((id) => {
      const b = blocks.get(id);
      if (!b || b.type === 'consent' || !('compliance' in b)) return;
      if (b.compliance.purposeIds.some((p) => consentPurposes.has(p))) {
        soft('consent_after_consent_fields', jsonPointer('blocks', id), `'${id}' relies on consent but comes before the consent block '${consentId}'`);
      }
    });
  }

  return issues;
}
