import type { EmailDoc, PlainTemplate } from '@form/schema';
import { describe, expect, it } from 'vitest';
import {
  answered,
  compiledOf,
  copyOf,
  definitionOf,
  emailDoc,
  maskedField,
  MARKETING,
  omittedField,
  para,
  personal,
  pipe,
  RESPOND,
  table,
  text,
} from '../../../test/email-fixtures.ts';
import { disclosableFields, MASK, type DisclosableField } from '../disclosure.ts';
import { escapeHtml, oneLine, renderEmail, renderLine, selectVariant } from './render.ts';

/*
 * WP-1.16 NOT-02/04: an EmailDoc and a subject template as the message that is sent. Fields come from the real
 * `disclosableFields` over a definition compiled by the real `compile`, so what the notification may disclose is decided
 * where it is decided in production and the renderer is tested against its output, not against a hand-made list.
 */

const PAN = 'ABCDE1234F';
const SSN = '123-45-6789';

/** The standard case: a plain name, a masked PAN, an omitted SSN, a marketing-only phone, and a copy of the PAN. */
function fieldsFor(answers: Record<string, [string, unknown]>, o: { purposeIds?: string[]; sensitiveOverride?: 'mask' | 'omit' } = {}): DisclosableField[] {
  const blocks = [
    personal('name'),
    personal('note'),
    maskedField('pan', 'PAN'),
    omittedField('ssn', 'SSN'),
    personal('promo_phone', { purposeIds: [MARKETING] }, { label: 'Promo phone' }),
    copyOf('pan_copy', 'pan'),
  ];
  const definition = definitionOf(blocks);
  return disclosableFields({
    definition,
    compiled: compiledOf(definition),
    answers: answered(answers),
    purposeIds: o.purposeIds ?? [RESPOND],
    channel: 'notification',
    sensitiveOverride: o.sensitiveOverride,
  });
}

const everything: Record<string, [string, unknown]> = {
  name: ['short_text', 'Asha'],
  note: ['short_text', 'hello'],
  pan: ['short_text', PAN],
  ssn: ['short_text', SSN],
  promo_phone: ['short_text', '9876543210'],
  pan_copy: ['hidden', PAN],
};

const subjectOf = (...parts: PlainTemplate): PlainTemplate => parts;
/** A merge tag in a subject template. */
const tag = (blockId: string, o: Parameters<typeof pipe>[1] = {}) => ({ pipe: pipe(blockId, o).attrs });
const bodyWith = (...nodes: unknown[]): EmailDoc => emailDoc(...nodes);

describe('renderEmail: escaping', () => {
  const XSS = '<script>alert(1)</script>';

  it('escapes a value in a merge tag and in the answers table, in the html part', () => {
    const fields = fieldsFor({ ...everything, name: ['short_text', XSS] });
    const { html, text: plain } = renderEmail(bodyWith(para(text('Hello '), pipe('name')), table()), ['New response'], fields);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    // Twice: once in the paragraph, once in the table cell.
    expect(html.split('&lt;script&gt;alert(1)&lt;/script&gt;')).toHaveLength(3);
    // The plain-text part is text, so the value stands as the respondent typed it.
    expect(plain).toContain(`Hello ${XSS}`);
  });

  it('escapes quotes and ampersands, in text and in the label of a row', () => {
    const definition = definitionOf([personal('odd', {}, { label: 'Name <b>"x"</b> & co' })]);
    const fields = disclosableFields({
      definition,
      compiled: compiledOf(definition),
      answers: answered({ odd: ['short_text', `"><img src=x onerror=alert(1)> & 'q'`] }),
      purposeIds: [RESPOND],
      channel: 'notification',
    });
    const { html } = renderEmail(bodyWith(table()), ['s'], fields);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('Name &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; co');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;q&#39;');
  });

  it('keeps a line break in a long answer as <br> and never lets it open a tag', () => {
    const fields = fieldsFor({ ...everything, note: ['short_text', 'line one\nline <two>'] });
    const { html } = renderEmail(bodyWith(table({ include: ['note'] })), ['s'], fields);
    expect(html).toContain('line one<br>line &lt;two&gt;');
  });

  it('escapes the subject in the html title and strips CR and LF from the subject itself', () => {
    const fields = fieldsFor({ ...everything, name: ['short_text', 'Asha\r\nBcc: evil@example.test\nX-Injected: 1'] });
    const rendered = renderEmail(bodyWith(para(text('x'))), subjectOf('Hi ', tag('name'), ' <b>!</b>'), fields);
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.subject).toBe('Hi Asha Bcc: evil@example.test X-Injected: 1 <b>!</b>');
    expect(rendered.html).toContain('<title>Hi Asha Bcc: evil@example.test X-Injected: 1 &lt;b&gt;!&lt;/b&gt;</title>');
  });

  it('oneLine drops every kind of line break, including the Unicode ones, and cuts a very long subject', () => {
    expect(oneLine('a\r\nb\rc\nd\u0085e\u{2028}f\u{2029}g\u0000h')).toBe('a b c d e f g h');
    expect(oneLine('  spaced   out  ')).toBe('spaced out');
    expect([...oneLine('x'.repeat(1000))]).toHaveLength(255);
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('an answer that reads like a marker word is still an answer', () => {
    const fields = fieldsFor({ ...everything, name: ['short_text', 'empty'] });
    expect(renderEmail(bodyWith(para(pipe('name', { fallback: 'none given' }))), ['s'], fields).text).toBe('empty\n');
  });
});

describe('renderEmail: masking, omission and purpose, in the body, the subject and the table', () => {
  const fields = fieldsFor(everything);
  const subject = subjectOf('Response from ', tag('name'), ' PAN ', tag('pan'), ' ssn:', tag('ssn'));
  const body = bodyWith(
    para(text('PAN: '), pipe('pan'), text(' SSN: '), pipe('ssn'), text(' Promo: '), pipe('promo_phone'), text(' Copy: '), pipe('pan_copy')),
    table(),
  );
  const rendered = renderEmail(body, subject, fields);

  it('shows MASK for a field whose setting is mask: in the body, in the subject pipe and in the answers table', () => {
    expect(rendered.subject).toContain(`PAN ${MASK}`);
    expect(rendered.html).toContain(`PAN: ${MASK}`);
    expect(rendered.text).toContain(`PAN: ${MASK}`);
    // The table row is the PAN's label and the mask.
    expect(rendered.html).toMatch(new RegExp(`<th[^>]*>PAN</th><td[^>]*>${MASK}</td>`));
    expect(rendered.text).toContain(`PAN: ${MASK}\n`);
  });

  it('leaves an omitted field and a field outside the notification’s purposes out of all three, label and value', () => {
    for (const secret of [SSN, '9876543210', 'SSN</th>', 'Promo phone']) {
      expect(rendered.html).not.toContain(secret);
      expect(rendered.text).not.toContain(secret);
      expect(rendered.subject).not.toContain(secret);
    }
    expect(rendered.subject).toBe(`Response from Asha PAN ${MASK} ssn:`);
    // The pipes of the two withheld fields leave nothing behind, not even a "not given".
    expect(rendered.text).toContain(`SSN:  Promo:  Copy: ${MASK}`);
  });

  it('masks a value derived from a sensitive field (taint), though its own setting says include', () => {
    expect(rendered.text).toContain(`Copy: ${MASK}`);
    for (const out of [rendered.html, rendered.text, rendered.subject]) expect(out).not.toContain(PAN);
  });

  it('never carries a raw sensitive value anywhere in the message', () => {
    for (const out of [rendered.html, rendered.text, rendered.subject]) {
      expect(out).not.toContain(PAN);
      expect(out).not.toContain(SSN);
    }
  });

  it('gives a recipient of the marketing purpose the phone and not the name', () => {
    const marketing = renderEmail(bodyWith(para(pipe('name'), text('|'), pipe('promo_phone')), table()), ['s'], fieldsFor(everything, { purposeIds: [MARKETING] }));
    expect(marketing.text).toContain('|9876543210');
    expect(marketing.text).not.toContain('Asha');
  });

  it('applies the notification’s sensitiveOverride: omit removes the masked field from all three', () => {
    const omitted = renderEmail(body, subject, fieldsFor(everything, { sensitiveOverride: 'omit' }));
    expect(omitted.text).not.toContain(MASK);
    expect(omitted.html).not.toContain(MASK);
    expect(omitted.html).not.toMatch(/<th[^>]*>PAN<\/th>/);
    expect(omitted.subject).toBe('Response from Asha PAN ssn:');
  });
});

describe('renderEmail: the answers table', () => {
  const fields = fieldsFor({ name: ['short_text', 'Asha'], pan: ['short_text', PAN] });

  it('lists every allowed field by default, in document order, and a blank one as a blank row', () => {
    const { text: plain } = renderEmail(bodyWith(table()), ['s'], fields);
    expect(plain).toBe(`Label of name: Asha\nLabel of note: \nPAN: ${MASK}\nLabel of pan_copy: \n`);
  });

  it('hideEmpty leaves out a field nobody answered', () => {
    const { text: plain } = renderEmail(bodyWith(table({ hideEmpty: true })), ['s'], fieldsFor({ name: ['short_text', 'Asha'], pan: ['short_text', PAN], pan_copy: ['hidden', PAN] }));
    expect(plain).toBe(`Label of name: Asha\nPAN: ${MASK}\nLabel of pan_copy: ${MASK}\n`);
  });

  it('include names the blocks, in the order given, once each, and never adds a field the notification may not disclose', () => {
    const { text: plain } = renderEmail(bodyWith(table({ include: ['pan', 'name', 'pan', 'ssn', 'promo_phone', 'unknown'] })), ['s'], fieldsFor(everything));
    expect(plain).toBe(`PAN: ${MASK}\nLabel of name: Asha\n`);
  });

  it('maskSensitive false cannot reveal a masked value: the row is left out', () => {
    const { text: plain, html } = renderEmail(bodyWith(table({ include: ['name', 'pan'], maskSensitive: false })), ['s'], fields);
    expect(plain).toBe('Label of name: Asha\n');
    expect(html).not.toContain(PAN);
    expect(html).not.toContain(MASK);
  });

  it('renders no table at all when nothing is left to show', () => {
    expect(renderEmail(bodyWith(table({ include: ['ssn'] })), ['s'], fieldsFor(everything)).html).not.toContain('<table width="100%"');
  });
});

describe('renderEmail: pipes and fallbacks', () => {
  const fields = fieldsFor({ name: ['short_text', 'Asha K'] });

  it('uses the fallback for an unanswered field and nothing for a field that is not disclosable', () => {
    const { text: plain } = renderEmail(bodyWith(para(pipe('note', { fallback: 'no note' }), text('|'), pipe('ssn', { fallback: 'no ssn' }), text('|'), pipe('nope', { fallback: 'no such' }))), ['s'], fields);
    expect(plain).toBe('no note||\n');
  });

  it('resolves submission references and the form title, and leaves the unsupported ones to their fallback', () => {
    const { text: plain } = renderEmail(
      bodyWith(
        para(
          {
            type: 'pipe',
            attrs: { source: { kind: 'submission', key: 'submission_id' } },
          } as never,
          text(' / '),
          { type: 'pipe', attrs: { source: { kind: 'submission', key: 'form_title' } } } as never,
          text(' / '),
          { type: 'pipe', attrs: { source: { kind: 'submission', key: 'submitted_at' } } } as never,
          text(' / '),
          { type: 'pipe', attrs: { source: { kind: 'submission', key: 'edit_url' }, fallback: 'n/a' } } as never,
        ),
      ),
      ['s'],
      fields,
      { submissionId: 'sub-1', formTitle: 'Contact us', receivedAt: new Date('2026-11-16T08:33:21Z') },
    );
    expect(plain).toBe('sub-1 / Contact us / 2026-11-16 08:33 UTC / n/a\n');
  });

  it('percent-encodes a piped value when the pipe asks for it', () => {
    const { text: plain } = renderEmail(bodyWith(para(pipe('name', { encode: 'url' }))), ['s'], fields);
    expect(plain).toBe('Asha%20K\n');
  });

  it('renderLine resolves a template the same way and as one line', () => {
    expect(renderLine(['Forms for ', tag('name'), '\r\n'], fields)).toBe('Forms for Asha K');
  });
});

describe('renderEmail: rich text, links and buttons', () => {
  const fields = fieldsFor({ name: ['short_text', 'Asha'] });
  const bold = { type: 'text', text: 'Bold', marks: [{ type: 'bold' }, { type: 'italic' }] };
  const link = (href: string) => ({ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href } }] });

  it('renders headings, lists, quotes, rules and marks as escaped html and as plain text', () => {
    const { html, text: plain } = renderEmail(
      bodyWith(
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title <1>' }] },
        { type: 'paragraph', attrs: { align: 'center' }, content: [bold, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a & b' }] }] }] },
        { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
        { type: 'horizontalRule' },
      ),
      ['s'],
      fields,
    );
    expect(html).toContain('<h2 ');
    expect(html).toContain('Title &lt;1&gt;');
    expect(html).toContain('text-align:center;');
    expect(html).toContain('<em><strong>Bold</strong></em>');
    expect(html).toContain('<br>two');
    expect(html).toContain('<li style="margin:0 0 4px">a &amp; b</li>');
    expect(html).toContain('<ol start="3"');
    expect(html).toContain('<blockquote');
    expect(html).toContain('<hr');
    expect(plain).toBe('Title <1>\n\nBold\ntwo\n\n- a & b\n\n3. third\n\n> quoted\n\n----------\n');
  });

  it('does not let a stored heading level, alignment, list start or colour write markup of its own', () => {
    const { html } = renderEmail(
      bodyWith(
        { type: 'heading', attrs: { level: 'x><script>alert(1)</script>', align: 'left;background:url(x)' }, content: [{ type: 'text', text: 'T' }] },
        { type: 'orderedList', attrs: { start: '1" onclick="x' }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'i' }] }] }] },
        para({ type: 'text', text: 'c', marks: [{ type: 'textColor', attrs: { color: 'red;position:fixed' } }] } as never),
      ),
      ['s'],
      fields,
    );
    expect(html).toContain('<h3 ');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('background:url');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('position:fixed');
  });

  it('links only to http, https, mailto and tel; anything else is its text', () => {
    const { html, text: plain } = renderEmail(
      bodyWith(
        para(link('https://example.org/a?b=1&c=2') as never),
        para(link('javascript:alert(1)') as never),
        para(link('data:text/html,<script>alert(1)</script>') as never),
        para(link('/relative') as never),
        para(link('mailto:help@example.org') as never),
      ),
      ['s'],
      fields,
    );
    expect(html).toContain('<a href="https://example.org/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow"');
    expect(html).toContain('<a href="mailto:help@example.org"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text');
    expect(html).not.toContain('href="/relative"');
    expect(plain).toContain('click (https://example.org/a?b=1&c=2)');
  });

  it('the view_submission button goes to the builder at PUBLIC_BUILDER_URL, with the response in the query', () => {
    const body = bodyWith({ type: 'button', attrs: { label: 'View <response>', action: 'view_submission' } });
    const options = { publicBuilderUrl: 'https://forms.example.org/', formId: 'f 1', submissionId: 'sub-1' };
    const { html, text: plain } = renderEmail(body, ['s'], fields, options);
    expect(html).toContain('href="https://forms.example.org/forms/f%201/responses?submission=sub-1"');
    expect(html).toContain('>View &lt;response&gt;</a>');
    expect(plain).toBe('View <response>: https://forms.example.org/forms/f%201/responses?submission=sub-1\n');
    // No builder URL, or one that is not http(s): no button.
    expect(renderEmail(body, ['s'], fields, { ...options, publicBuilderUrl: '' }).html).not.toContain('<a href');
    expect(renderEmail(body, ['s'], fields, { ...options, publicBuilderUrl: 'javascript:alert(1)' }).html).not.toContain('<a href');
  });

  it('a url button resolves its template with the answers percent-encoded, and refuses a result that is not http(s)', () => {
    const open = (url: PlainTemplate) => renderEmail(bodyWith({ type: 'button', attrs: { label: 'Go', action: { url } } }), ['s'], fieldsFor({ name: ['short_text', 'a/b?c=d&e#f'] }));
    expect(open(['https://example.org/hi?name=', tag('name')]).text).toBe('Go: https://example.org/hi?name=a%2Fb%3Fc%3Dd%26e%23f\n');
    // An answer cannot supply the scheme or the host: it is encoded, so the result is not an address at all.
    expect(open([tag('name')]).html).not.toContain('<a href');
    expect(open(['javascript:alert(1)']).html).not.toContain('<a href');
  });

  it('leaves out what is not drawn yet: images, brand blocks and the edit, withdraw and resume buttons', () => {
    const { html } = renderEmail(
      bodyWith(
        { type: 'image', attrs: { asset: 'asset_1' } },
        { type: 'brandBlock', attrs: { part: 'footer' } },
        { type: 'button', attrs: { label: 'Edit', action: 'edit_submission' } },
        { type: 'button', attrs: { label: 'Withdraw', action: 'withdraw_consent' } },
        { type: 'button', attrs: { label: 'Resume', action: 'resume_draft' } },
        para(text('kept')),
      ),
      ['s'],
      fields,
      { publicBuilderUrl: 'https://forms.example.org', formId: 'f', submissionId: 's' },
    );
    expect(html).toContain('kept');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Edit');
    expect(html).not.toContain('Withdraw');
    expect(html).not.toContain('Resume');
  });

  it('writes the html lang from the locale and ignores one that is not a language tag', () => {
    expect(renderEmail(bodyWith(), ['s'], fields, { locale: 'hi-IN' }).html).toContain('<html lang="hi-IN">');
    expect(renderEmail(bodyWith(), ['s'], fields, { locale: '"><script>' }).html).toContain('<html lang="en">');
  });
});

describe('selectVariant', () => {
  const variant = (id: string, locale: string | undefined, subject: string) => ({ id, name: id, ...(locale ? { locale } : {}), subject: [subject], body: emailDoc(para(text(subject))) });
  const base = { subject: ['English'] as PlainTemplate, body: emailDoc(para(text('English'))) };
  const config = (locale: string, variants = [variant('hi', 'hi-IN', 'Hindi'), variant('ta', 'ta', 'Tamil'), variant('rule', undefined, 'By rule')]) => ({ ...base, locale, variants }) as never;

  it('follows the respondent’s language for locale "respondent": whole tag, then language, then the notification’s own', () => {
    expect(selectVariant(config('respondent'), 'hi-IN').subject).toEqual(['Hindi']);
    expect(selectVariant(config('respondent'), 'hi').subject).toEqual(['Hindi']);
    expect(selectVariant(config('respondent'), 'ta-IN').subject).toEqual(['Tamil']);
    expect(selectVariant(config('respondent'), 'en-IN').subject).toEqual(['English']);
    expect(selectVariant(config('respondent'), undefined).subject).toEqual(['English']);
  });

  it('a fixed locale picks its variant whatever language the respondent used, and a variant with no locale is never picked by language', () => {
    expect(selectVariant(config('hi-IN'), 'en-IN')).toMatchObject({ subject: ['Hindi'], locale: 'hi-IN' });
    expect(selectVariant(config('fr-FR'), 'hi-IN').subject).toEqual(['English']);
    expect(selectVariant({ ...base, locale: 'respondent' } as never, 'hi-IN').subject).toEqual(['English']);
  });

  it('renders the variant’s body, not the base one', () => {
    const chosen = selectVariant(config('respondent'), 'hi-IN');
    expect(renderEmail(chosen.body, chosen.subject, [], { locale: chosen.locale }).text).toBe('Hindi\n');
  });
});
