import type { EmailBodyNode, EmailDoc, InlineNode, ListItemNode, Mark, NotificationConfig, PipeAttrs, PlainTemplate, RichBlockNode } from '@form/schema';
import { MASK, type DisclosableField } from '../disclosure.ts';

/*
 * An EmailDoc and a subject template as the message that is sent (WP-1.16, NOT-02/04). The one rule of this file: a value
 * reaches the email only from `disclosableFields`' output. The answers table, a merge tag in the body and a merge tag in the
 * subject all read the same `fields` list, so what is out of the notification's purposes or omitted is in none of the three,
 * and what is masked (by the field's setting, by the notification's override or by taint) is `MASK` in all of them. This file
 * never sees a stored answer, so there is no path around the filter to forget.
 *
 * Every value is escaped for where it lands: HTML text and attributes in the html part, nothing special in the plain-text
 * part, no line breaks in the subject. A link or button goes out only with an http(s), mailto or tel address, and an answer
 * piped into a URL is percent-encoded whatever the pipe says, so it can add no host, path or query of its own.
 *
 * Not drawn yet: images (they need the org's asset URLs), `brandBlock` (the brand kit), `var` nodes (the org profile), the
 * edit, withdraw and resume buttons (WP-2.18, WP-1.21) and number or date formats of a pipe (it shows the field's text).
 */

/** What a notification knows about the response besides its answers; every field is optional so a test can render a bare doc. */
export interface EmailRenderOptions {
  /** The builder's origin without a trailing slash: the "view response" button links into it. Without it that button is left out. */
  publicBuilderUrl?: string | undefined;
  formId?: string | undefined;
  formTitle?: string | undefined;
  submissionId?: string | undefined;
  receivedAt?: Date | undefined;
  /** The `lang` of the html part (the language the message is written in). */
  locale?: string | undefined;
}

export interface RenderedEmail {
  /** One line, no CR or LF. */
  subject: string;
  html: string;
  text: string;
}

const MAX_SUBJECT = 255;

/** A control character, or a Unicode line or paragraph separator: nothing a header, a display name or an error line may carry. */
export const isControl = (code: number): boolean => code <= 0x1f || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;

/** `text` with each run of control characters (line breaks included) replaced by `by`. */
export function replaceControls(text: string, by = ' '): string {
  let out = '';
  let inRun = false;
  for (const ch of text) {
    if (isControl(ch.codePointAt(0)!)) {
      if (!inRun) out += by;
      inRun = true;
    } else {
      out += ch;
      inRun = false;
    }
  }
  return out;
}

/** The subject as one header line: breaks and control characters become one space, runs of space collapse, and it is cut at 255 characters. */
export function oneLine(text: string): string {
  return [...replaceControls(text).replace(/ {2,}/g, ' ').trim()].slice(0, MAX_SUBJECT).join('').trim();
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** Text for an html body: escaped, and a line break in a value (a long answer) is kept. */
const htmlText = (text: string): string => escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');

/** Only a link a mail client can open safely; anything else (javascript:, data:, a relative path) is plain text. */
function safeHref(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  return ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) ? url.href : undefined;
}

/** A button or a template URL: http(s) only. */
function webHref(href: string): string | undefined {
  const safe = safeHref(href);
  return safe !== undefined && /^https?:/i.test(safe) ? safe : undefined;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ALIGNS = new Set(['left', 'center', 'right', 'justify']);

const FONT = "-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Sans Devanagari',Arial,sans-serif";
const COLOR_TEXT = '#1a1a1a';
const COLOR_RULE = '#e4e4e7';

const alignStyle = (align: unknown): string => (typeof align === 'string' && ALIGNS.has(align) ? `text-align:${align};` : '');

type Source = PipeAttrs['source'];
type Resolved = { kind: 'text'; text: string } | { kind: 'empty' } | { kind: 'withheld' };
const EMPTY: Resolved = { kind: 'empty' };
const WITHHELD: Resolved = { kind: 'withheld' };

class Renderer {
  readonly byBlock = new Map<string, DisclosableField>();
  readonly fields: readonly DisclosableField[];
  readonly options: EmailRenderOptions;

  constructor(fields: readonly DisclosableField[], options: EmailRenderOptions) {
    this.fields = fields;
    this.options = options;
    for (const f of fields) this.byBlock.set(f.blockId, f);
  }

  /**
   * What one source shows: `text`, `empty` (the author's fallback applies) or `withheld` (the field is out of the
   * notification's purposes, omitted or unknown: nothing shows, not even a fallback, so the email does not say "not given"
   * about an answer that was given and held back). A tagged result, so an answer that reads "empty" is still an answer.
   */
  private source(source: Source): Resolved {
    if (source.kind === 'answer') {
      // A sub-path (`full_name.first`) needs the typed value, which a masked or plain-text row does not carry.
      if (source.path !== undefined) return EMPTY;
      const field = this.byBlock.get(source.blockId);
      if (!field) return WITHHELD;
      if (field.masked) return { kind: 'text', text: MASK };
      return field.answered && field.text !== '' ? { kind: 'text', text: field.text } : EMPTY;
    }
    if (source.kind === 'submission') {
      switch (source.key) {
        case 'form_title':
          return this.options.formTitle === undefined ? EMPTY : { kind: 'text', text: this.options.formTitle };
        case 'submission_id':
          return this.options.submissionId === undefined ? EMPTY : { kind: 'text', text: this.options.submissionId };
        case 'submitted_at':
          return this.options.receivedAt ? { kind: 'text', text: `${this.options.receivedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` } : EMPTY;
        default:
          return EMPTY;
      }
    }
    return EMPTY;
  }

  /** A merge tag as text. */
  pipe(attrs: PipeAttrs): string {
    const value = this.source(attrs.source);
    if (value.kind === 'withheld') return '';
    if (value.kind === 'empty' || value.text === '') return attrs.fallback ?? '';
    return attrs.encode === 'url' ? encodeURIComponent(value.text) : value.text;
  }

  /** A plain template as text: literal parts as written, merge tags resolved, template variables by their fallback. */
  template(template: PlainTemplate): string {
    return template.map((part) => (typeof part === 'string' ? part : 'pipe' in part ? this.pipe(part.pipe) : (part.var.fallback ?? ''))).join('');
  }

  /** A URL template: every piped value is percent-encoded, whatever the pipe's `encode`, and the result must be an http(s) address. */
  url(template: PlainTemplate): string | undefined {
    const joined = template
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!('pipe' in part)) return encodeURIComponent(part.var.fallback ?? '');
        const value = this.source(part.pipe.source);
        if (value.kind === 'withheld') return '';
        return encodeURIComponent(value.kind === 'empty' || value.text === '' ? (part.pipe.fallback ?? '') : value.text);
      })
      .join('');
    return webHref(joined);
  }

  // ─── rich text ───────────────────────────────────────────────────────────────────────────────────────────────

  private markedHtml(text: string, marks: readonly Mark[] | undefined): string {
    let html = escapeHtml(text);
    let link: string | undefined;
    for (const mark of marks ?? []) {
      switch (mark.type) {
        case 'bold':
          html = `<strong>${html}</strong>`;
          break;
        case 'italic':
          html = `<em>${html}</em>`;
          break;
        case 'underline':
          html = `<u>${html}</u>`;
          break;
        case 'strike':
          html = `<s>${html}</s>`;
          break;
        case 'code':
          html = `<code style="font-family:Menlo,Consolas,monospace">${html}</code>`;
          break;
        case 'textColor': {
          const color = mark.attrs.color;
          if (typeof color === 'string' && HEX_COLOR.test(color)) html = `<span style="color:${color}">${html}</span>`;
          break;
        }
        case 'highlight': {
          const color = mark.attrs.color;
          if (typeof color === 'string' && HEX_COLOR.test(color)) html = `<span style="background-color:${color}">${html}</span>`;
          break;
        }
        case 'link':
          link = safeHref(String(mark.attrs.href));
          break;
      }
    }
    return link === undefined ? html : `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer nofollow" style="color:#1d4ed8">${html}</a>`;
  }

  private inlineHtml(node: InlineNode): string {
    switch (node.type) {
      case 'text':
        return this.markedHtml(node.text, node.marks);
      case 'hardBreak':
        return '<br>';
      case 'pipe':
        return htmlText(this.pipe(node.attrs));
      case 'var':
        return escapeHtml(node.attrs.fallback ?? '');
    }
  }

  private inlineText(node: InlineNode): string {
    switch (node.type) {
      case 'text': {
        const href = node.marks?.flatMap((m) => (m.type === 'link' ? [safeHref(String(m.attrs.href))] : [])).find((h) => h !== undefined);
        return href !== undefined && href !== node.text && !/^mailto:|^tel:/.test(href) ? `${node.text} (${href})` : node.text;
      }
      case 'hardBreak':
        return '\n';
      case 'pipe':
        return this.pipe(node.attrs);
      case 'var':
        return node.attrs.fallback ?? '';
    }
  }

  private inline(nodes: readonly InlineNode[] | undefined, as: 'html' | 'text'): string {
    return (nodes ?? []).map((n) => (as === 'html' ? this.inlineHtml(n) : this.inlineText(n))).join('');
  }

  private listHtml(node: Extract<RichBlockNode, { type: 'bulletList' | 'orderedList' }>): string {
    const items = node.content.map((item) => `<li style="margin:0 0 4px">${this.listItemHtml(item)}</li>`).join('');
    if (node.type === 'bulletList') return `<ul style="margin:0 0 16px;padding-left:24px">${items}</ul>`;
    const start = node.attrs?.start;
    const startAttr = typeof start === 'number' && Number.isInteger(start) && start > 1 && start < 100000 ? ` start="${start}"` : '';
    return `<ol${startAttr} style="margin:0 0 16px;padding-left:24px">${items}</ol>`;
  }

  private listItemHtml(item: ListItemNode): string {
    return item.content
      .map((child) => (child.type === 'paragraph' ? this.inline(child.content, 'html') : this.listHtml(child)))
      .join('');
  }

  private listText(node: Extract<RichBlockNode, { type: 'bulletList' | 'orderedList' }>, depth: number): string {
    const start = node.type === 'orderedList' && typeof node.attrs?.start === 'number' ? node.attrs.start : 1;
    return node.content
      .map((item, i) => {
        const marker = node.type === 'bulletList' ? '-' : `${start + i}.`;
        const pad = '  '.repeat(depth);
        const parts = item.content.map((child) => (child.type === 'paragraph' ? this.inline(child.content, 'text') : `\n${this.listText(child, depth + 1)}`));
        return `${pad}${marker} ${parts.join('')}`;
      })
      .join('\n');
  }

  // ─── blocks ──────────────────────────────────────────────────────────────────────────────────────────────

  private tableRows(attrs: Extract<EmailBodyNode, { type: 'answersTable' }>['attrs']): DisclosableField[] {
    let rows: DisclosableField[];
    if (attrs.include === 'all') rows = [...this.fields];
    else rows = [...new Set(attrs.include as string[])].flatMap((id) => {
      const field = this.byBlock.get(id);
      return field ? [field] : [];
    });
    if (attrs.hideEmpty) rows = rows.filter((f) => f.answered);
    // `maskSensitive: false` cannot show a value that is masked (a notification only ever gets stricter); it leaves the row out.
    if (!attrs.maskSensitive) rows = rows.filter((f) => !f.masked);
    return rows;
  }

  private buttonHref(attrs: Extract<EmailBodyNode, { type: 'button' }>['attrs']): string | undefined {
    const { action } = attrs;
    if (typeof action !== 'string') return this.url(action.url);
    if (action !== 'view_submission') return undefined;
    const { publicBuilderUrl, formId, submissionId } = this.options;
    if (!publicBuilderUrl || !formId || !submissionId) return undefined;
    const base = webHref(publicBuilderUrl);
    if (base === undefined) return undefined;
    return `${base.replace(/\/+$/, '')}/forms/${encodeURIComponent(formId)}/responses?submission=${encodeURIComponent(submissionId)}`;
  }

  private blockHtml(node: EmailBodyNode): string {
    switch (node.type) {
      case 'paragraph':
        return `<p style="margin:0 0 16px;${alignStyle(node.attrs?.align)}">${this.inline(node.content, 'html')}</p>`;
      case 'heading': {
        // The level names a tag, so it is checked here and not trusted from the stored document.
        const level = node.attrs.level === 1 || node.attrs.level === 2 ? node.attrs.level : 3;
        const size = { 1: 24, 2: 20, 3: 17 }[level];
        return `<h${level} style="margin:0 0 12px;font-size:${size}px;line-height:1.3;${alignStyle(node.attrs.align)}">${this.inline(node.content, 'html')}</h${level}>`;
      }
      case 'bulletList':
      case 'orderedList':
        return this.listHtml(node);
      case 'blockquote':
        return `<blockquote style="margin:0 0 16px;padding:0 0 0 12px;border-left:3px solid ${COLOR_RULE};color:#52525b">${node.content.map((p) => this.inline(p.content, 'html')).join('<br>')}</blockquote>`;
      case 'horizontalRule':
        return `<hr style="border:0;border-top:1px solid ${COLOR_RULE};margin:16px 0">`;
      case 'answersTable': {
        const rows = this.tableRows(node.attrs);
        if (rows.length === 0) return '';
        const cells = rows
          .map(
            (f) =>
              `<tr><th scope="row" align="left" valign="top" style="padding:8px 12px 8px 0;border-bottom:1px solid ${COLOR_RULE};font-weight:600;width:35%">${htmlText(f.label)}</th>` +
              `<td valign="top" style="padding:8px 0;border-bottom:1px solid ${COLOR_RULE}">${htmlText(f.masked ? MASK : f.text)}</td></tr>`,
          )
          .join('');
        return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px">${cells}</table>`;
      }
      case 'button': {
        const href = this.buttonHref(node.attrs);
        if (href === undefined) return '';
        return `<p style="margin:0 0 16px"><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 20px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(node.attrs.label)}</a></p>`;
      }
      case 'image':
      case 'brandBlock':
        return '';
    }
  }

  private blockText(node: EmailBodyNode): string {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        return this.inline(node.content, 'text');
      case 'bulletList':
      case 'orderedList':
        return this.listText(node, 0);
      case 'blockquote':
        return node.content.map((p) => `> ${this.inline(p.content, 'text')}`).join('\n');
      case 'horizontalRule':
        return '----------';
      case 'answersTable':
        return this.tableRows(node.attrs)
          .map((f) => `${f.label}: ${f.masked ? MASK : f.text}`)
          .join('\n');
      case 'button': {
        const href = this.buttonHref(node.attrs);
        return href === undefined ? '' : `${node.attrs.label}: ${href}`;
      }
      case 'image':
      case 'brandBlock':
        return '';
    }
  }

  document(doc: EmailDoc, subject: string): { html: string; text: string } {
    const body = doc.content.map((n) => this.blockHtml(n)).filter((h) => h !== '').join('\n');
    const lang = this.options.locale && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(this.options.locale) ? this.options.locale : 'en';
    const html =
      `<!doctype html>\n<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(subject)}</title></head>\n` +
      `<body style="margin:0;padding:0;background:#f4f4f5">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">` +
      `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px"><tr>` +
      `<td style="padding:24px;font-family:${FONT};font-size:15px;line-height:1.5;color:${COLOR_TEXT}">\n${body}\n</td></tr></table></td></tr></table></body></html>\n`;
    const text = `${doc.content
      .map((n) => this.blockText(n))
      .filter((t) => t !== '')
      .join('\n\n')}\n`;
    return { html, text };
  }
}

/**
 * The message for one recipient set. `fields` is `disclosableFields`' output for this notification and this response; the
 * doc and subject are the notification's (or its locale variant's). Pure: the same inputs give the same message, which is
 * what lets `email.send` render again at send time and `notification.dispatch` hash the subject without sending anything.
 */
export function renderEmail(doc: EmailDoc, subject: PlainTemplate, fields: readonly DisclosableField[], options: EmailRenderOptions = {}): RenderedEmail {
  const renderer = new Renderer(fields, options);
  const line = oneLine(renderer.template(subject));
  const { html, text } = renderer.document(doc, line);
  return { subject: line, html, text };
}

/** A template as one header line (a sender's display name): merge tags resolved from `fields`, no line breaks. */
export function renderLine(template: PlainTemplate, fields: readonly DisclosableField[], options: EmailRenderOptions = {}): string {
  return oneLine(new Renderer(fields, options).template(template));
}

type VariantSource = Pick<NotificationConfig, 'locale' | 'subject' | 'body' | 'variants'>;

/**
 * The subject and body to send: the locale variant that matches, or the notification's own. `locale: 'respondent'` follows the
 * language the respondent filled the form in (`submissions.meta.locale`); a fixed locale follows that. A variant matches by the
 * whole tag (`hi-IN`), then by language (`hi`). A variant with no locale is for rules that pick it by id (NOT-10), never by language.
 */
export function selectVariant(config: VariantSource, respondentLocale: string | undefined): { subject: PlainTemplate; body: EmailDoc; locale: string | undefined } {
  const wanted = config.locale === 'respondent' ? respondentLocale : config.locale;
  const base = { subject: config.subject, body: config.body, locale: wanted };
  if (!wanted || !config.variants || config.variants.length === 0) return base;
  const tag = wanted.toLowerCase();
  const language = tag.split('-')[0];
  const exact = config.variants.find((v) => v.locale?.toLowerCase() === tag);
  const sameLanguage = config.variants.find((v) => v.locale !== undefined && v.locale.toLowerCase().split('-')[0] === language);
  const chosen = exact ?? sameLanguage;
  return chosen ? { subject: chosen.subject, body: chosen.body, locale: wanted } : base;
}
