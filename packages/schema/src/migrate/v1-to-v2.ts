import { fromHtml, fromHtmlInline } from '../richtext/fromHtml.ts';
import { normalizeRichDoc } from '../richtext/normalize.ts';
import { jsonPointer } from '../validate/structure.ts';
import type * as V1 from '../v1.ts';
import type { ComparableKind, FieldBlock, StoredBlock } from '../v2/blocks.ts';
import type { ValueFieldType } from '../v2/catalogue.ts';
import type { FieldCompliance, Purpose } from '../v2/compliance.ts';
import type { BlockConfigMap, ChoiceOption, DefaultText, OtherOption } from '../v2/config.ts';
import { SCHEMA_VERSION, type FormDefinition } from '../v2/definition.ts';
import type { BlockLayout, BlockStyle, FieldMessages } from '../v2/envelope.ts';
import type { I18nBundle } from '../v2/i18n.ts';
import type {
  BlockId, ConditionId, DecimalString, EndingId, FieldKey, FontId, FormId, HexColor, IsoDate, IsoTime, Locale, OptionId, PageId, PurposeId, RuleId,
} from '../v2/ids.ts';
import type { Condition, ConditionGroup, LogicOperator, Operand, Rule } from '../v2/logic.ts';
import type { MigrationContext, V1MigrationResult } from '../v2/migration.ts';
import type { AccessConfig, RetentionOps } from '../v2/ops.ts';
import type { Ending, Page } from '../v2/pages.ts';
import type { InlineDoc, InlineNode, RichDoc } from '../v2/rich-text.ts';
import type { Behavior, Theme } from '../v2/theme.ts';
import { IsoDateSchema, IsoTimeSchema, RESERVED_KEYS, isDecimalString, isOpaqueId, isSafeUrl } from '../v2/zod/primitives.ts';
import { Notes, type NoteCode } from './notes.ts';

/*
 * v1 → v2 (schema §4.2). Pure: ids come from `ctx.idFactory`, nothing reads a clock, the host locale or randomness.
 * v1 HTML (labels, help text, paragraphs, thank-you screens, the success message) is read only through the
 * `fromHtml` allowlist; plain v1 strings (title, description, option labels, the closed message) stay text.
 */

type Customize = Readonly<Record<string, unknown>>;
interface Entry { block: V1.FormBlock; index: number; id: string }
interface Reserved { block: V1.FormBlock; index: number; keep: boolean }
interface PageDraft { id: string; title?: string; entries: Entry[]; at: string }

/** The v2 value type of each v1 input type; the other v1 types are content, page breaks and thank-you screens. */
export const V1_VALUE_TYPES: Readonly<Partial<Record<V1.FieldType, ValueFieldType>>> = {
  text: 'short_text', long_text: 'long_text', number: 'number', email: 'email', phone: 'phone', url: 'url',
  dropdown: 'single_choice', multiple_choice: 'single_choice', checkbox: 'multi_choice', multi_select: 'multi_choice',
  date: 'date', time: 'time', rating: 'rating', linear_scale: 'linear_scale', nps: 'nps', ranking: 'ranking',
  file_upload: 'file_upload', signature: 'signature', hidden: 'hidden',
};
/** Types whose config branch keeps the default or notes why not. */
const NOTED_DEFAULT_TYPES: ReadonlySet<ValueFieldType> = new Set(['short_text', 'long_text', 'email', 'url', 'number', 'nps', 'linear_scale']);
/** v1 `defaultValues()` skipped these (multi-value and hidden fields), and file and signature inputs never showed it. */
const UNUSED_DEFAULT_TYPES: ReadonlySet<ValueFieldType> = new Set(['multi_choice', 'ranking', 'hidden', 'file_upload', 'signature']);
const HEADING_LEVELS: Readonly<Partial<Record<V1.FieldType, 1 | 2 | 3>>> = { heading: 1, heading_2: 2, heading_3: 3 };
/** v1 rendered a placeholder only for these. */
const PLACEHOLDER_TYPES: ReadonlySet<V1.FieldType> = new Set(['text', 'long_text', 'number', 'email', 'phone', 'url', 'dropdown']);
/** v1 rendered prefix and suffix only for these. */
const AFFIX_TYPES: ReadonlySet<V1.FieldType> = new Set(['text', 'number', 'email']);
/** v1 applied `errorMessage`, `min`, `max` and `pattern` to these as strings (zodFromBlocks' default branch). */
const STRING_RULE_TYPES: ReadonlySet<V1.FieldType> = new Set(['text', 'long_text', 'phone', 'date', 'time']);

const OPERATORS: Readonly<Record<V1.LogicOperator, LogicOperator>> = {
  equals: 'eq', not_equals: 'neq', contains: 'contains', not_contains: 'not_contains', starts_with: 'starts_with', ends_with: 'ends_with',
  greater_than: 'gt', less_than: 'lt', answered: 'is_answered', not_answered: 'is_not_answered', is_empty: 'is_not_answered',
};
const ORDERED_ALIASES: Readonly<Partial<Record<LogicOperator, LogicOperator>>> = { gt: 'after', lt: 'before' };
const FONTS: ReadonlyMap<string, string> = new Map([['Inter', 'inter'], ['Georgia', 'georgia'], ['Mono', 'mono']]);
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'ckb', 'dv', 'fa', 'he', 'ks', 'ps', 'sd', 'ug', 'ur', 'yi']);
const LABEL_WEIGHTS: ReadonlySet<string> = new Set(['normal', 'medium', 'semibold', 'bold']);
const STYLE_COLORS = ['labelColor', 'inputTextColor', 'inputBg', 'borderColor', 'placeholderColor'] as const;

const DEFAULT_PURPOSE = 'Respond to this form';
const MAX_FILES = 20;

const brand = <T>(value: string): T => value as T;
const str = (c: Customize, key: string): string | undefined => (typeof c[key] === 'string' ? (c[key] as string) : undefined);
const finite = (c: Customize, key: string): number | undefined => (typeof c[key] === 'number' && Number.isFinite(c[key]) ? (c[key] as number) : undefined);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const quoted = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}...` : s);

/** `#rrggbb` / `#rrggbbaa`, with `#rgb` expanded; anything else is not a v2 colour. */
export function hexColor(value: unknown): HexColor | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return brand<HexColor>(s);
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(s);
  return short ? brand<HexColor>(`#${short.slice(1).map((d) => d + d).join('')}`) : undefined;
}

/** A v1 number (or numeric string, as v1's `Number()` read it) as an exact decimal; null when it has none within 10 decimals. */
export function toDecimal(raw: string | number): DecimalString | null {
  let s = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : '') : raw.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) {
    const n = Number(s);
    if (s === '' || !Number.isFinite(n)) return null;
    s = String(n);
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const int = (m[2] ?? '').replace(/^0+(?=\d)/, '') || '0';
  const frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length > 10) return null;
  const body = frac ? `${int}.${frac}` : int;
  const out = m[1] === '-' && /[1-9]/.test(body) ? `-${body}` : body;
  return isDecimalString(out) ? brand<DecimalString>(out) : null;
}

/** The answer range the v1 builder drew for a linear scale (e1be409): `scaleMin..scaleMax`, rounded, with no cap (BL-109). */
function v1ScaleRange(c: Customize): [number, number] {
  return [Math.round(finite(c, 'scaleMin') ?? 1), Math.round(finite(c, 'scaleMax') ?? 5)];
}

/** Whether `x <op> n` is true for some, and false for some, integer x in [lo, hi]; undefined for other operators. */
function outcomes(op: LogicOperator, n: number, [lo, hi]: [number, number]): { some: boolean; none: boolean } | undefined {
  const hit = Number.isInteger(n) && n >= lo && n <= hi;
  const miss = hi > lo || n !== lo;
  switch (op) {
    case 'eq': return { some: hit, none: miss };
    case 'neq': return { some: miss, none: hit };
    case 'gt': return { some: hi > n, none: lo <= n };
    case 'lt': return { some: lo < n, none: hi >= n };
    default: return undefined;
  }
}

/** ASCII slug for a FieldKey: accents folded, everything else outside [a-z0-9] collapsed to '_'. */
export function slugOf(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[A-Z]/g, (ch) => ch.toLowerCase())
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Plain text (as v1 rendered it) → RichDoc: one paragraph, line breaks kept. */
function plainDoc(text: string): RichDoc {
  const content = text.split(/\r\n?|\n/).flatMap((line, i): InlineNode[] => [...(i ? [{ type: 'hardBreak' as const }] : []), ...(line ? [{ type: 'text' as const, text: line }] : [])]);
  return normalizeRichDoc({ type: 'doc', content: [{ type: 'paragraph', content }] });
}

type Built =
  | { combinator: 'all' | 'any'; negate?: boolean; conditions: Array<Omit<Condition, 'kind' | 'id' | 'left'>>; changed?: string }
  | { fail: NoteCode; detail: string };

class V1Migration {
  private readonly notes = new Notes();
  private readonly used = new Set<string>();
  private readonly keys = new Set<string>(RESERVED_KEYS);
  private readonly blocks: Partial<Record<BlockId, StoredBlock>> = {};
  /** For each v1 block (by index), which of its option ids are kept; claimed before any id is generated. */
  private readonly keptOptions = new Map<number, boolean[]>();
  private readonly form: V1.FormSchema;
  private readonly ctx: MigrationContext;
  private readonly locale: Locale;
  private purposeId = brand<PurposeId>('');

  constructor(form: V1.FormSchema, ctx: MigrationContext) {
    this.form = form;
    this.ctx = ctx;
    this.locale = ctx.orgDefaults.locale;
  }

  private fresh(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.ctx.idFactory();
      if (isOpaqueId(id) && !this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
    throw new Error('MigrationContext.idFactory keeps returning invalid or used ids');
  }

  private inline(html: string, path: string): InlineDoc {
    const { doc, dropped } = fromHtmlInline(html);
    if (dropped.length) this.notes.add('html_sanitised', path, `removed ${dropped.join(', ')}`);
    return doc;
  }

  private rich(html: string, path: string): RichDoc {
    const { doc, dropped } = fromHtml(html);
    if (dropped.length) this.notes.add('html_sanitised', path, `removed ${dropped.join(', ')}`);
    return doc;
  }

  /** A string config value: absent when blank, cut to `max` characters with a note. */
  private text(value: string | undefined, max: number, path: string): string | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    if (value.length <= max) return value;
    this.notes.add('clamped', path, `cut to ${max} characters`);
    return value.slice(0, max);
  }

  /** An integer in [min, max]; a note when v1's value had to change. */
  private int(value: number, min: number, max: number, path: string, what: string): number {
    const out = Math.min(max, Math.max(min, Math.round(value)));
    if (out !== value) this.notes.add('clamped', path, `${what} ${value} is now ${out} (v2 allows ${min}–${max})`);
    return out;
  }

  run(): V1MigrationResult {
    const { form } = this;
    const settings = form.settings;
    const reserved = this.reserve();
    const formId = isOpaqueId(form.id) ? form.id : this.freshFormId();
    const entries = this.assignIds(reserved);
    const pages = this.paginate(entries);
    const endings = this.endings(entries);
    this.purposeId = brand<PurposeId>(this.fresh());

    for (const page of pages) for (const entry of page.entries) this.convert(entry);
    const rules = this.logic(entries, pages);
    const valueBlocks = Object.values(this.blocks).filter((b) => b !== undefined && 'compliance' in b).length;
    if (valueBlocks) this.notes.add('compliance_defaulted', '/blocks', `${valueBlocks} field(s) take the registry default compliance and the purpose '${DEFAULT_PURPOSE}'`);
    this.notes.add('default_purpose_added', jsonPointer('privacy', 'purposes', 0), `'${DEFAULT_PURPOSE}' (legitimate use, s.7(a)); the notice must be approved before publish (CMP-24)`);

    const defaultEnding = endings.find((e) => e.kind === 'redirect') ?? endings[0];
    const definition: FormDefinition = {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      formId: brand<FormId>(formId),
      title: this.text(form.title, 500, '/title') ?? '',
      ...(form.description.trim() ? { description: plainDoc(form.description) } : {}),
      blocks: this.blocks,
      pages: pages.map((p): Page => ({ id: brand<PageId>(p.id), ...(p.title ? { title: p.title } : {}), children: p.entries.map((e) => brand<BlockId>(e.id)) })),
      endings,
      defaultEndingId: brand<EndingId>(defaultEnding?.id ?? ''),
      logic: { rules, ruleGroups: [], variables: [] },
      privacy: {
        fiduciary: {
          legalName: [{ var: { name: 'org.legal_name' } }],
          contactEmail: [{ var: { name: 'org.support_email' } }],
          privacyContact: { name: [{ var: { name: 'org.privacy_contact.name' } }], email: [{ var: { name: 'org.privacy_contact.email' } }] },
          rightsUrl: [{ var: { name: 'org.rights_url' } }],
          boardComplaintInfo: [{ var: { name: 'org.board_complaint_info' } }],
        },
        purposes: [this.defaultPurpose()],
        children: { mode: 'not_applicable' },
        encryption: { mode: 'server' },
        dropAnswersWithoutConsent: true,
        networkSignals: { ipHash: true, userAgentHash: true, ttlDays: 30 },
      },
      theme: this.theme(settings),
      behavior: this.behavior(settings),
      i18n: this.i18n(),
    };

    const result: V1MigrationResult = { definition, ops: { access: this.access(settings), retention: RETENTION() }, assetImports: [], notes: this.notes.list };
    if (settings.password !== '') {
      result.plaintextPasswordToHash = settings.password;
      this.notes.add('password_extracted', '/settings/password', 'the password is hashed by the API (argon2id) and never stored in the form');
    }
    for (const [target, key] of [['logo', 'logoUrl'], ['cover', 'coverUrl']] as const) {
      const url = settings[key].trim();
      if (!url) continue;
      if (isSafeUrl(url)) {
        result.assetImports.push({ target, url });
        this.notes.add('external_asset_queued', `/settings/${key}`, `${quoted(url)} is imported into the asset store; it is dropped if unreachable`);
      } else {
        this.notes.add('external_asset_queued', `/settings/${key}`, `${quoted(url)} is not an http(s) URL; dropped`);
      }
    }
    return result;
  }

  private freshFormId(): string {
    const id = this.fresh();
    this.notes.add('key_generated', '/formId', `form id ${quoted(this.form.id)} is not a valid id; it is now '${id}'`);
    return id;
  }

  /**
   * Claims every v1 id that is kept before any id is generated, so `fresh()` never repeats one: block ids that are
   * valid and unique (I1, in v1 `order`), then option ids that are valid and unique within their block, then the
   * source ids of dangling rules, which stay their disabled rule's left operand (BL-110).
   */
  private reserve(): Reserved[] {
    const sorted = this.form.blocks.map((block, index) => ({ block, index })).sort((a, b) => a.block.order - b.block.order || a.index - b.index);
    const reserved = sorted.map(({ block, index }) => {
      const keep = isOpaqueId(block.id) && !this.used.has(block.id);
      if (keep) this.used.add(block.id);
      return { block, index, keep };
    });
    for (const { block, index } of reserved) {
      const seen = new Set<string>();
      this.keptOptions.set(index, (block.options ?? []).map((o) => {
        const keep = isOpaqueId(o.id) && !seen.has(o.id);
        seen.add(o.id);
        if (keep) this.used.add(o.id);
        return keep;
      }));
    }
    const v1Ids = new Set(this.form.blocks.map((b) => b.id));
    for (const { block } of reserved) {
      const source = block.logic?.sourceBlockId;
      if (source && !v1Ids.has(source) && isOpaqueId(source)) this.used.add(source);
    }
    return reserved;
  }

  /** Blocks in v1 `order`; every block keeps its v1 id when that id is valid and unique (I1). */
  private assignIds(reserved: Reserved[]): Entry[] {
    return reserved.map(({ block, index, keep }) => {
      let id = block.id;
      if (!keep) {
        id = this.fresh();
        this.notes.add('key_generated', `/blocks/${index}/id`, `block id ${quoted(block.id)} is not a valid, unique id; it is now '${id}'`);
      }
      return { block, index, id };
    });
  }

  /** Page breaks split pages (a break's id names the next page); thank-you blocks become endings; B10 trailing pages go. */
  private paginate(entries: Entry[]): PageDraft[] {
    const pages: PageDraft[] = [{ id: this.fresh(), entries: [], at: '' }];
    for (const entry of entries) {
      const { block } = entry;
      if (block.type === 'page_break') {
        const title = this.text(this.ctx.htmlToPlain(block.label).trim(), 200, `/blocks/${entry.index}/label`);
        pages.push({ id: entry.id, ...(title ? { title } : {}), entries: [], at: `/blocks/${entry.index}` });
        if (block.logic?.enabled && block.logic.sourceBlockId) this.notes.add('logic_rule_disabled', `/blocks/${entry.index}/logic`, 'v1 ignored logic on page breaks; dropped');
      } else if (block.type !== 'thank_you') {
        pages.at(-1)?.entries.push(entry);
      }
    }
    const isInput = (e: Entry) => V1_VALUE_TYPES[e.block.type] !== undefined;
    while (pages.length > 1 && !pages.at(-1)?.entries.some(isInput)) {
      const last = pages.pop() as PageDraft;
      (pages.at(-1) as PageDraft).entries.push(...last.entries);
      const moved = last.entries.length ? `; its ${last.entries.length} content block(s) moved to the previous page` : '';
      this.notes.add('empty_trailing_page_removed', last.at, `the last page has no question${moved}`);
    }
    const kept = pages.filter((p, i) => p.entries.length > 0 || i === 0);
    for (const page of pages) {
      if (!kept.includes(page)) this.notes.add('empty_trailing_page_removed', page.at, 'empty page removed (v1 skipped it)');
    }
    if (kept.length > 1 && !kept[0]?.entries.length) kept.shift();
    return kept;
  }

  private endings(entries: Entry[]): Ending[] {
    const settings = this.form.settings;
    const success = (path: string) => this.rich(settings.successMessage, path);
    const message = (id: string, name: string, content: RichDoc): Ending => ({
      id: brand<EndingId>(id), kind: 'message', name, content, actions: [{ kind: 'fill_again', prefill: 'none' }], confetti: settings.successAnimation,
    });
    const endings: Ending[] = [];
    for (const { block, id, index } of entries) {
      if (block.type !== 'thank_you') continue;
      const at = jsonPointer('endings', endings.length);
      const content = this.rich(block.label, `${at}/content`);
      const name = this.text(this.ctx.htmlToPlain(block.label).split('\n')[0]?.trim(), 200, `${at}/name`) ?? 'Thank you';
      endings.push(message(id, name, content.content.length ? content : success(`${at}/content`)));
      if (block.logic?.enabled && block.logic.sourceBlockId) this.notes.add('logic_rule_disabled', `/blocks/${index}/logic`, 'v1 ignored logic on thank-you blocks; dropped');
    }
    if (!endings.length) endings.push(message(this.fresh(), 'Thank you', success(jsonPointer('endings', 0, 'content'))));
    const url = settings.redirectUrl.trim();
    if (url) {
      if (isSafeUrl(url) && /^https:/i.test(url)) {
        const first = endings[0] as Extract<Ending, { kind: 'message' }>;
        endings.push({ id: brand<EndingId>(this.fresh()), kind: 'redirect', name: 'Redirect', url: [url], message: first.content });
      } else {
        this.notes.add('redirect_dropped', '/settings/redirectUrl', `${quoted(url)} is not an https URL`);
      }
    }
    return endings;
  }

  private defaultPurpose(): Purpose {
    return {
      id: this.purposeId,
      name: DEFAULT_PURPOSE,
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read and act on what you send in this form.' }] }] },
      lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: 'The respondent provides these details to have this form handled.' },
      retention: { kind: 'org_default' },
    };
  }

  private compliance(type: ValueFieldType): FieldCompliance {
    const defaults = clone(this.ctx.registry[type].defaultCompliance);
    return { ...defaults, purposeIds: defaults.classification === 'none' ? [] : [this.purposeId] };
  }

  private keyFor(entry: Entry, type: ValueFieldType): FieldKey {
    let base = slugOf(this.ctx.htmlToPlain(entry.block.label)) || type;
    if (!/^[a-z]/.test(base)) base = `f_${base}`;
    let key = base.slice(0, 64).replace(/_+$/, '');
    for (let n = 2; this.keys.has(key); n += 1) key = `${base.slice(0, 63 - String(n).length).replace(/_+$/, '')}_${n}`;
    this.keys.add(key);
    this.notes.add('key_generated', jsonPointer('blocks', entry.id, 'key'), `key '${key}'`);
    return brand<FieldKey>(key);
  }

  private layout(c: Customize): BlockLayout | undefined {
    if (c['width'] !== 'half') return undefined;
    return c['besidePrevious'] === true ? { width: 'half' } : { width: 'half', startNewRow: true };
  }

  private style(c: Customize, at: (...p: string[]) => string): BlockStyle | undefined {
    const style: BlockStyle = {};
    for (const key of STYLE_COLORS) {
      const color = hexColor(c[key]);
      if (color) style[key] = color;
    }
    const labelSize = finite(c, 'labelSize');
    if (labelSize !== undefined && labelSize > 0) style.labelSizePx = this.int(labelSize, 10, 48, at('style', 'labelSizePx'), 'label size');
    const inputSize = finite(c, 'inputSize');
    if (inputSize !== undefined && inputSize > 0) style.inputSizePx = this.int(inputSize, 10, 32, at('style', 'inputSizePx'), 'input size');
    const weight = str(c, 'labelWeight');
    if (weight && LABEL_WEIGHTS.has(weight)) style.labelWeight = weight as NonNullable<BlockStyle['labelWeight']>;
    const align = str(c, 'align');
    if (align === 'left' || align === 'center') style.align = align;
    return Object.keys(style).length ? style : undefined;
  }

  private convert(entry: Entry): void {
    const { block } = entry;
    const id = brand<BlockId>(entry.id);
    const c: Customize = block.customize ?? {};
    const layout = this.layout(c);
    const envelope = layout ? { layout } : {};
    const level = HEADING_LEVELS[block.type];
    if (level) {
      this.blocks[id] = { id, type: 'heading', ...envelope, config: { level, text: this.inline(block.label, jsonPointer('blocks', id, 'config', 'text')) } };
      return;
    }
    if (block.type === 'paragraph') {
      this.blocks[id] = { id, type: 'paragraph', ...envelope, config: { content: this.rich(block.label, jsonPointer('blocks', id, 'config', 'content')) } };
      return;
    }
    if (block.type === 'divider') {
      this.blocks[id] = { id, type: 'divider', ...envelope, config: { ...DIVIDER } };
      return;
    }
    const type = V1_VALUE_TYPES[block.type];
    if (type) this.blocks[id] = this.field(entry, type, c, envelope);
  }

  private field(entry: Entry, type: ValueFieldType, c: Customize, envelope: { layout?: BlockLayout }): FieldBlock {
    const { block } = entry;
    const id = brand<BlockId>(entry.id);
    const at = (...p: Array<string | number>) => jsonPointer('blocks', id, ...p);
    const validation = block.validation ?? {};
    let required = type !== 'hidden' && validation.required === true;
    if (type === 'hidden' && validation.required === true) {
      this.notes.add('clamped', at('required'), 'hidden fields are never required (v1 never asked for them); the field is optional');
    }
    const readOnly = c['disabled'] === true;
    if (readOnly && required) {
      required = false;
      this.notes.add('required_disabled_resolved', at('required'), 'disabled and required could never be submitted; the field is read-only and optional');
    }
    const config = this.config(entry, type, c, at);
    this.droppedDefault(type, c, config as Readonly<Record<string, unknown>>, at);
    const description = block.helpText?.trim() ? this.rich(block.helpText, at('description')) : undefined;
    const style = type === 'hidden' ? undefined : this.style(c, at);
    const messages = this.messages(entry, type, config as Readonly<Record<string, unknown>>, required, at);
    const plainLabel = this.ctx.htmlToPlain(block.label).trim();
    const field = {
      id,
      type,
      key: this.keyFor(entry, type),
      label: this.inline(block.label, at('label')),
      ...(c['hideLabel'] === true ? { hideLabel: true } : {}),
      ...(description?.content.length ? { description } : {}),
      required,
      ...(readOnly ? { readOnly: true } : {}),
      ...(c['autoFocus'] === true ? { autoFocus: true } : {}),
      ...(messages ? { messages } : {}),
      compliance: this.compliance(type),
      ...envelope,
      ...(style ? { style } : {}),
      ...(type === 'hidden' && plainLabel ? { note: this.text(plainLabel, 5000, at('note')) } : {}),
      config,
    };
    return field as FieldBlock;
  }

  private messages(entry: Entry, type: ValueFieldType, config: Readonly<Record<string, unknown>>, required: boolean, at: (...p: Array<string | number>) => string): FieldMessages | undefined {
    const message = this.text(entry.block.validation?.errorMessage?.trim(), 1000, at('messages'));
    if (!message) return undefined;
    const codes: Array<keyof FieldMessages> = required ? ['required'] : [];
    if (type === 'short_text') {
      if (config['minLength'] !== undefined) codes.push('too_short');
      if (config['maxLength'] !== undefined) codes.push('too_long');
      if (config['pattern'] !== undefined) codes.push('pattern');
    }
    if (type === 'long_text') {
      const limit = config['limit'] as { min?: number; max?: number } | undefined;
      if (limit?.min !== undefined) codes.push('too_short');
      if (limit?.max !== undefined) codes.push('too_long');
    }
    if (type === 'number') {
      if (config['min'] !== undefined) codes.push('below_min');
      if (config['max'] !== undefined) codes.push('above_max');
    }
    if (type === 'email') codes.push('invalid_email');
    if (type === 'url') codes.push('invalid_url');
    if (!codes.length) {
      this.notes.add('clamped', at('messages'), `the error message has no v2 message code on this ${type} field; dropped`);
      return undefined;
    }
    return Object.fromEntries(codes.map((code) => [code, message])) as FieldMessages;
  }

  private options(entry: Entry, at: (...p: Array<string | number>) => string): ChoiceOption[] {
    const kept = this.keptOptions.get(entry.index) ?? [];
    const values = new Map<string, number>();
    const options = (entry.block.options ?? []).map((o, i): ChoiceOption => {
      let id = o.id;
      if (!kept[i]) {
        id = this.fresh();
        this.notes.add('key_generated', at('config', 'options', i, 'id'), `option id ${quoted(o.id)} is not a valid, unique id; it is now '${id}'`);
      }
      const code = this.text(o.value, 200, at('config', 'options', i, 'code'));
      /* Counted on the stored code, so values that differ only after the 200-character cut are reported too. */
      values.set(code ?? o.value, (values.get(code ?? o.value) ?? 0) + 1);
      return { id: brand<OptionId>(id), label: o.label, ...(code !== undefined ? { code } : {}) };
    });
    for (const [value, count] of values) {
      if (count > 1) this.notes.add('duplicate_option_value', at('config', 'options'), `${count} options share the value ${quoted(value)}; their codes keep it`);
    }
    return options;
  }

  private choiceCommon(entry: Entry, c: Customize, at: (...p: Array<string | number>) => string, fallback: () => ChoiceOption[]): { options: ChoiceOption[]; other?: OtherOption; shuffle?: { keepLast: number } } {
    let options = this.options(entry, at);
    if (!options.length) {
      options = fallback().map((o) => ({ ...o, id: brand<OptionId>(this.fresh()) }));
      this.notes.add('clamped', at('config', 'options'), 'the field had no options; the default options were added');
    }
    return {
      options,
      ...(c['otherOption'] === true ? { other: { enabled: true, label: 'Other', textRequired: false } } : {}),
      ...(c['randomize'] === true ? { shuffle: { keepLast: 0 } } : {}),
    };
  }

  /** A default no type-specific branch kept or noted (choice, rating, date, time, phone and the rest). */
  private droppedDefault(type: ValueFieldType, c: Customize, config: Readonly<Record<string, unknown>>, at: (...p: Array<string | number>) => string): void {
    const raw = str(c, 'defaultValue');
    if (!raw?.trim() || NOTED_DEFAULT_TYPES.has(type) || config['defaultValue'] !== undefined || config['defaultOptionId'] !== undefined) return;
    const why = UNUSED_DEFAULT_TYPES.has(type) ? 'v1 never applied it'
      : type === 'phone' ? 'v2 phone fields have no default'
        : type === 'single_choice' ? 'it matches no option' : `it is not a valid ${type} value`;
    this.notes.add('clamped', at('config', 'defaultValue'), `default ${quoted(raw)} dropped: ${why}`);
  }

  private staticDefault(c: Customize, max: number, at: string): DefaultText | undefined {
    const value = str(c, 'defaultValue');
    if (value === undefined || value === '') return undefined;
    if (value.length > max) {
      this.notes.add('clamped', at, `the default value is longer than ${max} characters; dropped`);
      return undefined;
    }
    return { kind: 'static', value };
  }

  private config(entry: Entry, type: ValueFieldType, c: Customize, at: (...p: Array<string | number>) => string): BlockConfigMap[ValueFieldType] {
    const { block } = entry;
    const v = block.validation ?? {};
    const registry = this.ctx.registry;
    const placeholder = PLACEHOLDER_TYPES.has(block.type) ? this.text(block.placeholder, 200, at('config', 'placeholder')) : undefined;
    const chrome = {
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(AFFIX_TYPES.has(block.type) ? this.affixes(c, at) : {}),
    };
    const pattern = v.pattern?.trim() ? v.pattern : undefined;
    if (pattern !== undefined && type !== 'short_text') {
      const why = block.type === 'email' ? 'v1 never applied email patterns (B13)' : `v2 has no pattern for ${type} fields`;
      this.notes.add('unsafe_pattern_dropped', at('config'), `pattern ${quoted(pattern)} dropped: ${why}`);
    }
    if ((v.min !== undefined || v.max !== undefined) && !['short_text', 'long_text', 'number'].includes(type)) {
      this.notes.add('clamped', at('config'), `${STRING_RULE_TYPES.has(block.type) ? 'length' : 'value'} limits (min/max) have no v2 equivalent for ${type} fields; dropped`);
    }
    if ((type === 'nps' || type === 'linear_scale') && str(c, 'defaultValue')?.trim()) {
      this.notes.add('clamped', at('config'), `default ${quoted(str(c, 'defaultValue') ?? '')} dropped: NPS and scales start unanswered (B7)`);
    }
    switch (type) {
      case 'short_text': {
        const config: BlockConfigMap['short_text'] = { ...clone(registry.short_text.defaultConfig(this.locale)), ...chrome };
        const range = this.range(v, 10_000, at, ['minLength', 'maxLength']);
        Object.assign(config, range);
        const fixed = this.staticDefault(c, config.maxLength ?? 10_000, at('config', 'defaultValue'));
        if (fixed) config.defaultValue = fixed;
        if (pattern !== undefined) {
          if (pattern.length <= 256 && this.ctx.isSafePattern(pattern)) config.pattern = { source: pattern };
          else this.notes.add('unsafe_pattern_dropped', at('config', 'pattern'), `pattern ${quoted(pattern)} is invalid or unsafe (B12, S8)`);
        }
        return config;
      }
      case 'long_text': {
        const config: BlockConfigMap['long_text'] = { ...clone(registry.long_text.defaultConfig(this.locale)), ...chrome };
        const range = this.range(v, 50_000, at, ['min', 'max']);
        if (Object.keys(range).length) config.limit = { unit: 'characters', ...range };
        const fixed = this.staticDefault(c, range.max ?? 50_000, at('config', 'defaultValue'));
        if (fixed) config.defaultValue = fixed;
        if (c['showCharCount'] === true) config.showCounter = true;
        return config;
      }
      case 'email':
      case 'url': {
        const config = { ...clone(registry[type].defaultConfig(this.locale)), ...chrome };
        const fixed = this.staticDefault(c, 10_000, at('config', 'defaultValue'));
        return fixed ? { ...config, defaultValue: fixed } : config;
      }
      case 'phone':
        return { ...clone(registry.phone.defaultConfig(this.locale)), defaultCountry: this.ctx.orgDefaults.country, ...chrome };
      case 'number': {
        const config: BlockConfigMap['number'] = { ...clone(registry.number.defaultConfig(this.locale)), ...chrome };
        const min = v.min === undefined ? null : toDecimal(v.min);
        const max = v.max === undefined ? null : toDecimal(v.max);
        for (const [limit, raw, out] of [['min', v.min, min], ['max', v.max, max]] as const) {
          if (raw !== undefined && out === null) this.notes.add('clamped', at('config', limit), `${limit} ${raw} has no exact decimal within 10 places; dropped`);
        }
        if (min !== null && max !== null && Number(min) > Number(max)) {
          this.notes.add('clamped', at('config'), `min ${min} is above max ${max}; both dropped`);
        } else {
          if (min !== null) config.min = min;
          if (max !== null) config.max = max;
        }
        const raw = str(c, 'defaultValue');
        const fixed = raw === undefined || raw.trim() === '' ? null : toDecimal(raw);
        if (fixed !== null && (min === null || Number(fixed) >= Number(min)) && (max === null || Number(fixed) <= Number(max))) config.defaultValue = fixed;
        else if (raw?.trim()) this.notes.add('clamped', at('config', 'defaultValue'), `default ${quoted(raw)} is not a number within the limits; dropped`);
        return config;
      }
      case 'single_choice': {
        const common = this.choiceCommon(entry, c, at, () => clone(registry.single_choice.defaultConfig(this.locale).options));
        const config: BlockConfigMap['single_choice'] = { display: block.type === 'dropdown' ? 'dropdown' : 'radio', ...common, ...chrome };
        const fixed = str(c, 'defaultValue');
        const option = fixed ? (block.options ?? []).findIndex((o) => o.value === fixed) : -1;
        if (option >= 0 && common.options[option]) config.defaultOptionId = common.options[option].id;
        return config;
      }
      case 'multi_choice': {
        const common = this.choiceCommon(entry, c, at, () => clone(registry.multi_choice.defaultConfig(this.locale).options));
        return { display: block.type === 'multi_select' ? 'dropdown' : 'checkbox', ...common };
      }
      case 'ranking': {
        const { options } = this.choiceCommon(entry, c, at, () => clone(registry.ranking.defaultConfig(this.locale).options));
        return { ...clone(registry.ranking.defaultConfig(this.locale)), options, ...(c['randomize'] === true ? { shuffle: true } : {}) };
      }
      case 'date': {
        const config: BlockConfigMap['date'] = clone(registry.date.defaultConfig(this.locale));
        const fixed = str(c, 'defaultValue')?.trim();
        if (fixed && IsoDateSchema.safeParse(fixed).success) config.defaultValue = { kind: 'fixed', date: brand<IsoDate>(fixed) };
        return config;
      }
      case 'time': {
        const config: BlockConfigMap['time'] = clone(registry.time.defaultConfig(this.locale));
        const fixed = str(c, 'defaultValue')?.trim().slice(0, 5);
        if (fixed && IsoTimeSchema.safeParse(fixed).success) config.defaultValue = { kind: 'fixed', time: brand<IsoTime>(fixed) };
        return config;
      }
      case 'rating': {
        const config: BlockConfigMap['rating'] = clone(registry.rating.defaultConfig(this.locale));
        const max = finite(c, 'ratingMax');
        if (max !== undefined) config.max = this.int(max, 1, 10, at('config', 'max'), 'rating max');
        const fixed = Number(str(c, 'defaultValue') ?? Number.NaN);
        if (Number.isInteger(fixed) && fixed >= 1 && fixed <= config.max) config.defaultValue = fixed;
        return config;
      }
      case 'linear_scale': {
        const [v1Min, v1Max] = v1ScaleRange(c);
        const min: 0 | 1 = v1Min <= 0 ? 0 : 1;
        if (min !== v1Min) this.notes.add('clamped', at('config', 'min'), `scale start ${v1Min} is now ${min} (v2 scales start at 0 or 1)`);
        const max = this.int(v1Max, 2, 10, at('config', 'max'), 'scale end');
        const low = this.text(str(c, 'scaleMinLabel'), 200, at('config', 'lowLabel'));
        const high = this.text(str(c, 'scaleMaxLabel'), 200, at('config', 'highLabel'));
        return { min, max, ...(low !== undefined ? { lowLabel: low } : {}), ...(high !== undefined ? { highLabel: high } : {}) };
      }
      case 'file_upload': {
        const config: BlockConfigMap['file_upload'] = clone(registry.file_upload.defaultConfig(this.locale));
        if (c['allowMultiple'] === true) config.maxFiles = MAX_FILES;
        return config;
      }
      default:
        return clone(registry[type].defaultConfig(this.locale));
    }
  }

  private affixes(c: Customize, at: (...p: Array<string | number>) => string): { prefix?: string; suffix?: string } {
    const prefix = this.text(str(c, 'prefix'), 32, at('config', 'prefix'));
    const suffix = this.text(str(c, 'suffix'), 32, at('config', 'suffix'));
    return { ...(prefix !== undefined ? { prefix } : {}), ...(suffix !== undefined ? { suffix } : {}) };
  }

  /** v1 `validation.min/max` as character limits; both dropped when min > max. */
  private range<K extends string>(v: NonNullable<V1.FormBlock['validation']>, cap: number, at: (...p: Array<string | number>) => string, [lo, hi]: [K, K]): Partial<Record<K, number>> {
    const min = v.min === undefined ? undefined : this.int(v.min, 0, cap, at('config', lo), 'minimum length');
    const max = v.max === undefined ? undefined : this.int(v.max, 0, cap, at('config', hi), 'maximum length');
    if (min !== undefined && max !== undefined && min > max) {
      this.notes.add('clamped', at('config'), `minimum length ${min} is above maximum ${max}; both dropped`);
      return {};
    }
    return { ...(min !== undefined ? { [lo]: min } : {}), ...(max !== undefined ? { [hi]: max } : {}) } as Partial<Record<K, number>>;
  }

  private theme(s: V1.FormSettings): Theme {
    const colors: Theme['tokens']['colors'] = {};
    const page = hexColor(s.backgroundColor);
    const text = hexColor(s.textColor);
    const accent = hexColor(s.accentColor);
    if (page) colors.page = page;
    if (text) {
      colors.text = text;
      colors.inputText = text;
    }
    if (accent) colors.accent = accent;
    return {
      layout: 'classic',
      tokens: {
        colors,
        typography: { body: brand<FontId>(FONTS.get(s.font) ?? 'inter'), baseSizePx: 16 },
        radius: 'md',
        density: 'comfortable',
        formWidth: 'normal',
        labelAlign: 'top',
        inputStyle: 'outlined',
        progress: s.progressBar ? 'bar' : 'none',
      },
    };
  }

  private behavior(s: V1.FormSettings): Behavior {
    return {
      submit: { label: s.submitButtonText.trim() ? s.submitButtonText : 'Submit', align: 'left' },
      navigation: { allowBack: true, showPageTitles: false },
      saveAndResume: { enabled: false, showButton: false, delivery: [], expiryDays: 30 },
      localAutosave: { enabled: false, allowWithSensitive: false },
      timeZone: this.ctx.orgDefaults.timeZone,
      spam: { honeypot: true, minFillSeconds: 3, captcha: 'off' },
      urlPrefill: false,
      showBranding: true,
      a11y: { announceErrors: 'polite', focusFirstError: true },
      successAnimation: s.successAnimation,
    };
  }

  private i18n(): I18nBundle {
    const locale = this.locale;
    const language = locale.split('-')[0] ?? '';
    return {
      defaultLocale: locale,
      locales: [{ locale, direction: RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr' }],
      detect: ['url_param'],
      urlParam: 'lang',
      switcher: 'none',
      messages: {},
      systemMessages: {},
      reviewedConsentLocales: [],
    };
  }

  private access(s: V1.FormSettings): AccessConfig {
    return {
      enabled: !s.closed,
      uniqueSubmission: 'off',
      embedAllowlist: [],
      screens: s.closedMessage.trim() ? { closed: { content: plainDoc(s.closedMessage) } } : {},
    };
  }

  /* ── logic ──────────────────────────────────────────────────────────── */

  /** The v1 condition as v2 operators, typed by the source's registry paths and operators; or why it cannot be kept. */
  private condition(source: FieldBlock, v1op: V1.LogicOperator, value: string): Built {
    const definition = this.ctx.registry[source.type];
    const kind = (definition.paths as Readonly<Record<string, ComparableKind>>)[''];
    const allowed: readonly LogicOperator[] = (kind && definition.operators[kind]) || [];
    const op = OPERATORS[v1op];
    const fail = (code: NoteCode, detail: string): Built => ({ fail: code, detail });
    const notApplicable = () => fail('logic_rule_disabled', `'${v1op}' does not apply to ${source.type} fields in v2`);
    const one = (o: LogicOperator, right?: Operand, extra: { caseSensitive?: boolean; changed?: string } = {}): Built => {
      if (!allowed.includes(o)) return notApplicable();
      const { changed, caseSensitive } = extra;
      return { combinator: 'all', conditions: [{ op: o, ...(right ? { right } : {}), ...(caseSensitive ? { caseSensitive } : {}) }], ...(changed ? { changed } : {}) };
    };
    if (op === 'is_answered' || op === 'is_not_answered') return one(op);
    if (value === '') {
      /* v1 compared against the empty string; these have an exact v2 form. */
      if (v1op === 'equals') return one('is_not_answered', undefined, { changed: "'equals' an empty value is 'is not answered'" });
      if (v1op === 'not_equals') return one('is_answered', undefined, { changed: "'not equals' an empty value is 'is answered'" });
      if (v1op === 'not_contains') return { combinator: 'any', conditions: [], changed: "'not contains' an empty value is never true" };
      if (v1op !== 'greater_than' && v1op !== 'less_than') return { combinator: 'all', conditions: [], changed: `'${v1op}' an empty value is always true` };
    }
    switch (kind) {
      case 'text':
        if (op === 'gt' || op === 'lt') return fail('logic_rule_disabled', `v1 compared text with '${v1op}' as strings; v2 orders numbers, dates and times only`);
        return one(op, { kind: 'literal', value: { type: 'text', value } }, op === 'eq' || op === 'neq' ? { caseSensitive: true } : {});
      case 'number': {
        if (!['eq', 'neq', 'gt', 'lt'].includes(op)) return notApplicable();
        /* v1 ordered with Number() (an empty value is 0) but compared equality as text; v2 compares numbers (§4.2.1). */
        const n = toDecimal(value.trim() === '' ? '0' : value);
        if (n === null) return fail('logic_value_unmatched', `${quoted(value)} is not a number`);
        const changed = op === 'eq' || op === 'neq'
          ? `'${v1op}' ${quoted(value)} now compares numbers (${n}); v1 compared the answer as text, so '05' did not equal '5'`
          : n === value ? undefined : `${quoted(value)} is compared as the number ${n}`;
        return one(op, { kind: 'literal', value: { type: 'number', value: n } }, changed ? { changed } : {});
      }
      case 'date':
      case 'time': {
        if (!['eq', 'neq', 'gt', 'lt'].includes(op)) return notApplicable();
        const v = value.trim();
        const literal: Operand | null = kind === 'date'
          ? (IsoDateSchema.safeParse(v).success ? { kind: 'literal', value: { type: 'date', value: brand<IsoDate>(v) } } : null)
          : (IsoTimeSchema.safeParse(v).success ? { kind: 'literal', value: { type: 'time', value: brand<IsoTime>(v) } } : null);
        if (!literal) return fail('logic_value_unmatched', `${quoted(value)} is not a valid ${kind}`);
        return one(ORDERED_ALIASES[op] ?? op, literal);
      }
      case 'choice':
      case 'choices':
        return this.choiceCondition(source, kind, v1op, op, value, one, fail);
      default:
        return notApplicable();
    }
  }

  /** v1 compared the selected values (joined with spaces); options are matched by value, then by label. */
  private choiceCondition(
    source: FieldBlock, kind: 'choice' | 'choices', v1op: V1.LogicOperator, op: LogicOperator, value: string,
    one: (o: LogicOperator, right?: Operand, extra?: { changed?: string }) => Built, fail: (code: NoteCode, detail: string) => Built,
  ): Built {
    if (op !== 'eq' && op !== 'neq') return fail('logic_rule_disabled', `'${v1op}' on the values of a choice field has no v2 equivalent`);
    const options = (source.config as { options: ChoiceOption[] }).options;
    let matches = options.filter((o) => o.code === value);
    let changed: string | undefined;
    if (!matches.length) {
      matches = options.filter((o) => typeof o.label === 'string' && o.label === value);
      if (matches.length) changed = `no option has the value ${quoted(value)}; matched the option labelled ${quoted(value)}`;
    }
    if (!matches.length) return fail('logic_value_unmatched', `no option of '${source.key}' has the value or label ${quoted(value)}`);
    const right: Operand = { kind: 'options', blockId: source.id, optionIds: matches.map((o) => o.id) };
    const extra = changed ? { changed } : {};
    if (matches.length === 1) return one(op, right, extra);
    if (kind === 'choice') return one(op === 'eq' ? 'includes_any' : 'includes_none', right, { changed: changed ?? `${matches.length} options share the value ${quoted(value)}; any of them matches` });
    /* Several options share the value: v1 matched when exactly one of them was the whole selection. */
    const built = one('includes_any', right, extra);
    if ('fail' in built) return built;
    const count = one('count_eq', { kind: 'literal', value: { type: 'number', value: brand<DecimalString>('1') } });
    if ('fail' in count) return count;
    return {
      combinator: 'all',
      ...(op === 'neq' ? { negate: true } : {}),
      conditions: [...built.conditions, ...count.conditions],
      changed: changed ?? `${matches.length} options share the value ${quoted(value)}; exactly one of them must be the selection`,
    };
  }

  /**
   * A rule on a rating or scale whose range changed (B28): when its condition is always or never true on the migrated
   * range but was not on v1's, the answers that decided it are gone, so the rule is disabled rather than kept constant.
   */
  private rangeLost(v1: V1.FormBlock, source: FieldBlock, v1op: V1.LogicOperator, built: Exclude<Built, { fail: NoteCode }>): { code: NoteCode; detail: string } | undefined {
    const c: Customize = v1.customize ?? {};
    let before: [number, number];
    let after: [number, number];
    if (source.type === 'rating') {
      before = [1, Math.max(1, Math.round(finite(c, 'ratingMax') ?? 5))];
      after = [1, source.config.max];
    } else if (source.type === 'linear_scale') {
      before = v1ScaleRange(c);
      after = [source.config.min, source.config.max];
    } else {
      return undefined;
    }
    const [cond] = built.conditions;
    if (built.conditions.length !== 1 || !cond || cond.right?.kind !== 'literal' || cond.right.value.type !== 'number') return undefined;
    if (before[0] === after[0] && before[1] === after[1]) return undefined;
    const n = Number(cond.right.value.value);
    const was = outcomes(cond.op, n, before);
    const now = outcomes(cond.op, n, after);
    if (!was || !now || !(was.some && was.none) || (now.some && now.none)) return undefined;
    return {
      code: 'logic_value_unmatched',
      detail: `'${v1op}' ${cond.right.value.value} is ${now.some ? 'always' : 'never'} true on the migrated range ${after[0]}–${after[1]} (v1 allowed ${before[0]}–${before[1]})`,
    };
  }

  private logic(entries: Entry[], pages: PageDraft[]): Rule[] {
    const pageOf = new Map<string, number>();
    pages.forEach((p, i) => p.entries.forEach((e) => pageOf.set(e.id, i)));
    const orderOf = new Map(pages.flatMap((p) => p.entries).map((e, i) => [e.id, i]));
    const byV1Id = new Map<string, Entry>();
    for (const e of entries) if (!byV1Id.has(e.block.id)) byV1Id.set(e.block.id, e);

    /** `built` is the v2 condition, or why there is none; `disabled` says why a rule with a condition is still off. */
    interface Candidate { target: Entry; sourceId?: string; built: Built; disabled?: { code: NoteCode; detail: string }; v1op: V1.LogicOperator; action: 'show' | 'hide' }
    const candidates: Candidate[] = [];
    for (const target of entries) {
      const logic = target.block.logic;
      if (!logic?.enabled || !logic.sourceBlockId || !pageOf.has(target.id)) continue;
      const v1op = logic.operator ?? 'equals';
      const action = logic.action === 'hide' ? 'hide' : 'show';
      const sourceEntry = byV1Id.get(logic.sourceBlockId);
      const sourceId = sourceEntry?.id ?? (isOpaqueId(logic.sourceBlockId) ? logic.sourceBlockId : undefined);
      const source = sourceEntry ? this.blocks[brand<BlockId>(sourceEntry.id)] : undefined;
      const candidate: Candidate = { target, ...(sourceId !== undefined ? { sourceId } : {}), built: { fail: 'dangling_logic_source', detail: '' }, v1op, action };
      if (!source || !('compliance' in source)) {
        candidate.built = { fail: 'dangling_logic_source', detail: sourceEntry ? `source '${sourceEntry.id}' (${sourceEntry.block.type}) has no answer` : `source '${logic.sourceBlockId}' was deleted (B21)` };
      } else {
        candidate.built = this.condition(source, v1op, logic.value ?? '');
        const lost = sourceEntry && !('fail' in candidate.built) ? this.rangeLost(sourceEntry.block, source, v1op, candidate.built) : undefined;
        if (lost) candidate.disabled = lost;
        if ((pageOf.get(sourceEntry?.id ?? '') ?? 0) > (pageOf.get(target.id) ?? 0)) {
          candidate.disabled = { code: 'logic_rule_disabled', detail: `the source '${source.key}' is on a later page; a rule may only read earlier pages (I8)` };
        }
      }
      candidates.push(candidate);
    }

    /* Each v1 block has at most one rule, so the enabled rules form a functional graph; break each cycle at its last block. */
    const live = new Map(candidates.filter((c) => !('fail' in c.built) && !c.disabled).map((c) => [c.target.id, c]));
    for (const start of [...live.keys()]) {
      const path: string[] = [];
      let at: string | undefined = start;
      while (at !== undefined && live.has(at) && !path.includes(at)) {
        path.push(at);
        at = live.get(at)?.sourceId;
      }
      if (at === undefined || !path.includes(at)) continue;
      const cycle = path.slice(path.indexOf(at));
      const last = cycle.reduce((a, b) => ((orderOf.get(b) ?? 0) > (orderOf.get(a) ?? 0) ? b : a));
      const candidate = live.get(last) as Candidate;
      candidate.disabled = { code: 'logic_rule_disabled', detail: `rules read each other in a cycle (${[...cycle, at].join(' → ')}); v2 refuses logic cycles` };
      live.delete(last);
    }

    const rules: Rule[] = [];
    for (const c of candidates) {
      const at = jsonPointer('logic', 'rules', rules.length);
      const targetId = brand<BlockId>(c.target.id);
      if (c.sourceId === undefined) {
        this.notes.add('dangling_logic_source', `/blocks/${c.target.index}/logic`, `${'fail' in c.built ? c.built.detail : ''}; the rule is dropped`);
        continue;
      }
      const left: Operand = { kind: 'ref', ref: { kind: 'answer', blockId: brand<BlockId>(c.sourceId) } };
      let group: ConditionGroup;
      const off = 'fail' in c.built ? { code: c.built.fail, detail: c.built.detail } : c.disabled;
      if (off) this.notes.add(off.code, at, `${off.detail}; the rule is disabled`);
      if ('fail' in c.built) {
        /* No v2 condition: keep the v1 operator and value as text, so the author sees what the rule was. */
        const op = OPERATORS[c.v1op];
        const value = (c.target.block.logic?.value ?? '').slice(0, 10_000);
        const right: Operand | undefined = op === 'is_answered' || op === 'is_not_answered' ? undefined : { kind: 'literal', value: { type: 'text', value } };
        group = this.group('all', undefined, [{ kind: 'condition', id: brand<ConditionId>(this.fresh()), left, op, ...(right ? { right } : {}) }]);
      } else {
        if (c.built.changed) this.notes.add('logic_operator_changed', at, c.built.changed);
        const conditions = c.built.conditions.map((cond): Condition => ({ kind: 'condition', id: brand<ConditionId>(this.fresh()), left, ...cond }));
        group = this.group(c.built.combinator, c.built.negate, conditions);
      }
      const enabled = off === undefined;
      rules.push({ id: brand<RuleId>(this.fresh()), enabled, when: group, then: [{ type: c.action, targets: [targetId] }] });
      const target = this.blocks[targetId];
      if (enabled && c.action === 'show' && target && target.type !== 'unsupported') {
        target.initiallyHidden = true;
        this.notes.add('initially_hidden_set', jsonPointer('blocks', targetId, 'initiallyHidden'), 'hidden until the rule shows it, as in v1');
      }
    }
    return rules;
  }

  private group(combinator: 'all' | 'any', negate: boolean | undefined, children: Condition[]): ConditionGroup {
    return { kind: 'group', id: brand<ConditionId>(this.fresh()), combinator, ...(negate ? { negate } : {}), children };
  }
}

const DIVIDER: BlockConfigMap['divider'] = { lineStyle: 'solid', spacing: 'md' };
const RETENTION = (): RetentionOps => ({ basis: 'submitted_at', onExpiry: 'delete', files: 'with_submission', draftsDays: 30, trashDays: 30 });

/**
 * Migrates one v1 document (schema §4.2). The definition passes `validateDefinition(…, 'save')`; every change a
 * reader could notice is a `MigrationNote`. The form password is returned only in `plaintextPasswordToHash` (S5),
 * and external logo and cover URLs only in `assetImports` (S7).
 */
export function migrateV1ToV2(form: V1.FormSchema, ctx: MigrationContext): V1MigrationResult {
  return new V1Migration(form, ctx).run();
}
