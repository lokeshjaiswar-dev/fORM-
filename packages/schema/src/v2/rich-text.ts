import type { AssetRef, BlockId, CurrencyCode, HexColor, SafeHref, SafeUrl, TextAlign, VariableId } from './ids.ts';
import type { BrandRef, TemplateVariableName } from './template-primitives.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §2  RICH TEXT (FND-08) — TipTap/ProseMirror JSON subset; piping (PRE-02); template vars
 * ═════════════════════════════════════════════════════════════════════════ */

export type ThemeColorToken =
  | 'page' | 'surface' | 'text' | 'muted' | 'accent' | 'accentText'
  | 'inputBg' | 'inputBorder' | 'inputText' | 'error' | 'success';
/** Literal colour, theme token (preferred; survives theme changes) or brand-kit reference. */
export type ColorValue = HexColor | { token: ThemeColorToken } | BrandRef;

export type Mark =
  | { type: 'bold' } | { type: 'italic' } | { type: 'underline' } | { type: 'strike' } | { type: 'code' }
  /** rel="noopener noreferrer nofollow" and target are added by the renderer, never stored. */
  | { type: 'link'; attrs: { href: SafeHref } }
  | { type: 'textColor'; attrs: { color: ColorValue } }
  | { type: 'highlight'; attrs: { color: ColorValue } };

/** Request metadata readable by logic, pipes and expressions. */
export const META_KEYS = [
  'now', 'today', 'locale', 'time_zone', 'device', 'url_param', 'page_url', 'referrer', 'embed_origin',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'is_preview', 'row_index',
] as const;
export type MetaKey = (typeof META_KEYS)[number];

/**
 * Sub-path into a composite answer; the registry declares legal paths and their ComparableKind:
 *   full_name 'prefix'|'first'|'middle'|'last'|'suffix'   address 'line1'|…|'country'
 *   phone 'e164'|'country'   single/multi_choice 'other'|'score'|'count'|'labels'
 *   matrix '<rowId>'|'<rowId>.<colId>'   time 'start'|'end'   appointment 'start'|'end'
 *   payment 'total'|'subtotal'|'tax'   file_upload 'count'   consent '<consentItemId>'
 *   repeating_group 'count'
 */
export type AnswerPath = string;

/** Readable values. `row:'current'` binds to the same repeating-group row inside a row-scoped rule. */
export type ValueRef =
  | { kind: 'answer'; blockId: BlockId; path?: AnswerPath; row?: 'current' }
  | { kind: 'variable'; varId: VariableId }
  | { kind: 'meta'; key: MetaKey; name?: string };

/** Only valid after submit (endings, emails, PDFs, webhooks). Rejected in labels. */
export interface SubmissionRef {
  kind: 'submission';
  key: 'unique_id' | 'submission_id' | 'submitted_at' | 'edit_url' | 'pdf_url' | 'form_title' | 'withdraw_consent_url' | 'resume_url';
}
export type PipeSource = ValueRef | SubmissionRef;

/** Display formatting (LOG-19). Pure; never changes stored values. */
export type ValueFormat =
  | { kind: 'number'; decimals?: number; grouping?: 'none' | 'indian' | 'international'; decimalSeparator?: '.' | ','; prefix?: string; suffix?: string }
  | { kind: 'money'; currency?: CurrencyCode; grouping?: 'indian' | 'international' }
  | { kind: 'percent'; decimals?: number }
  | { kind: 'date'; pattern: DatePattern }
  | { kind: 'datetime'; pattern: DatePattern; hourCycle: 'h12' | 'h23' }
  | { kind: 'time'; hourCycle: 'h12' | 'h23' }
  | { kind: 'option'; show: 'label' | 'code' }
  | { kind: 'list'; separator: string }
  | { kind: 'text'; transform?: 'none' | 'upper' | 'lower' | 'title' };

export const DATE_PATTERNS = ['DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D MMM YYYY', 'MMMM D, YYYY'] as const;
export type DatePattern = (typeof DATE_PATTERNS)[number];

export interface PipeAttrs {
  source: PipeSource;
  format?: ValueFormat;
  /** Shown when the source is empty / hidden. Translatable. */
  fallback?: string;
  /** URL contexts only (redirects, buttons): percent-encode the value. */
  encode?: 'none' | 'url';
}
/** Answer piping atom (TipTap "mention"-style). Resolved live in the runtime, server-side in emails/PDFs. */
export interface PipeNode { type: 'pipe'; attrs: PipeAttrs }

/**
 * Template variable atom (§17.2). Allowed in drafts and template payloads; `live` vars stay as
 * nodes until publish resolves them (I11); `bake` vars are substituted at template use.
 */
export interface VarNode { type: 'var'; attrs: { name: TemplateVariableName; fallback?: string } }

export interface TextNode { type: 'text'; text: string; marks?: Mark[] }
export interface HardBreakNode { type: 'hardBreak' }
export type InlineNode = TextNode | HardBreakNode | PipeNode | VarNode;

export interface ParagraphNode { type: 'paragraph'; attrs?: { align?: TextAlign }; content?: InlineNode[] }
export interface HeadingNode { type: 'heading'; attrs: { level: 1 | 2 | 3; align?: TextAlign }; content?: InlineNode[] }
export interface ListItemNode { type: 'listItem'; content: Array<ParagraphNode | BulletListNode | OrderedListNode> }
export interface BulletListNode { type: 'bulletList'; content: ListItemNode[] }
export interface OrderedListNode { type: 'orderedList'; attrs?: { start?: number }; content: ListItemNode[] }
export interface BlockquoteNode { type: 'blockquote'; content: ParagraphNode[] }
export interface HorizontalRuleNode { type: 'horizontalRule' }
export interface ImageNode { type: 'image'; attrs: { asset: AssetRef | BrandRef; widthPct?: number; align?: TextAlign; href?: SafeUrl } }

export type RichBlockNode =
  | ParagraphNode | HeadingNode | BulletListNode | OrderedListNode | BlockquoteNode | HorizontalRuleNode | ImageNode;

/** Multi-block rich text: paragraphs, descriptions, endings, notices. ≤ 20k nodes, depth ≤ 8, lists depth ≤ 3. */
export interface RichDoc { type: 'doc'; content: RichBlockNode[] }
/** Exactly one paragraph: labels, sub-headings, option-free titles. */
export interface InlineDoc { type: 'doc'; content: [ParagraphNode] }

/** Single-line plain template: email subjects, sender names, redirect URLs, unique-ID prefixes, PDF footers. */
export type PlainTemplate = Array<string | { pipe: PipeAttrs } | { var: VarNode['attrs'] }>;
/** Short UI labels (option text, page titles, nav and submit labels, matrix rows) may pipe answers (PRE-02) and hold template vars. */
export type LabelText = string | PlainTemplate;
