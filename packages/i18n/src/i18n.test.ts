import { TYPE, parse, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { describe, expect, it, vi } from 'vitest';
import { EN_IN } from './catalogs';
import { createI18n, type MessageValues } from './i18n';
import { NAMESPACES, defineMessages, type MessageId } from './messages';
import { PSEUDO_CLOSE, PSEUDO_OPEN, findUnwrappedText } from './pseudo';

function argumentNames(elements: MessageFormatElement[], names = new Set<string>()): Set<string> {
  for (const element of elements) {
    if (element.type === TYPE.pound) continue;
    if (element.type !== TYPE.literal) names.add(element.value);
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) argumentNames(option.value, names);
    }
    if (element.type === TYPE.tag) argumentNames(element.children, names);
  }
  return names;
}

function sampleValues(source: string): MessageValues {
  const names = argumentNames(parse(source, { ignoreTag: true }));
  return Object.fromEntries([...names].map((name) => [name, 2]));
}

const allMessages = NAMESPACES.flatMap((ns) =>
  Object.entries(EN_IN[ns] ?? {}).map(([key, source]) => ({ id: `${ns}:${key}` as MessageId, source })),
);

describe('createI18n (en-IN)', () => {
  const i18n = createI18n('en-IN', EN_IN);

  it('formats catalogue messages with ICU plurals and arguments', () => {
    expect(i18n.t('system:nav.next')).toBe('Next');
    expect(i18n.t('system:too_short', { min: 1 })).toBe('Enter at least 1 character.');
    expect(i18n.t('system:too_short', { min: 5 })).toBe('Enter at least 5 characters.');
    expect(i18n.t('system:progress.label', { current: 2, total: 5 })).toBe('Page 2 of 5');
    expect(i18n.t('system:below_min', { min: i18n.formatNumber(100000) })).toBe('Enter 1,00,000 or more.');
  });

  it('formats number arguments with lakh grouping', () => {
    const custom = createI18n('en-IN', { renderer: { count: '{n} responses' } });
    expect(custom.t('renderer:count', { n: 1234567 })).toBe('12,34,567 responses');
  });

  it('formats numbers, money and dates for the locale', () => {
    expect(i18n.formatNumber(1234567.89)).toBe('12,34,567.89');
    expect(i18n.formatMoney('123456789', 'INR')).toBe('₹12,34,567.89');
    expect(i18n.formatDate('2026-09-05', 'DD-MM-YYYY')).toBe('05-09-2026');
    expect(i18n.formatDate('2026-09-05', 'D MMM YYYY')).toBe('5 Sep 2026');
    expect(i18n.formatTime('18:45', 'h12')).toBe('6:45 pm');
    expect(createI18n('en-US', EN_IN).formatNumber(1234567.89)).toBe('1,234,567.89');
  });

  it('never throws: missing keys, bad syntax and missing values are reported and return the id', () => {
    const onError = vi.fn();
    const broken = createI18n('en-IN', { renderer: { bad: 'Hello {name', needs: 'Hello {name}' } }, { onError });
    expect(broken.t('renderer:nope')).toBe('renderer:nope');
    expect(broken.t('renderer:bad')).toBe('renderer:bad');
    expect(broken.t('renderer:needs')).toBe('renderer:needs');
    expect(broken.t('renderer:bad')).toBe('renderer:bad');
    expect(onError.mock.calls.map(([e]) => e.kind)).toEqual(['missing', 'syntax', 'format', 'syntax']);
  });

  it('reports an invalid locale tag once and formats it as en-IN', () => {
    const onError = vi.fn();
    const bad = createI18n('en_IN', EN_IN, { onError });
    expect(onError.mock.calls).toEqual([[expect.objectContaining({ kind: 'locale', locale: 'en_IN' })]]);
    expect(bad.formatLocale).toBe('en-IN');
    expect(bad.t('system:nav.next')).toBe('Next');
    expect(bad.formatDate('2026-09-05', 'MMMM D, YYYY')).toBe('September 5, 2026');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('falls back to another catalogue set and lists keys missing from its own', () => {
    const hi = createI18n('hi-IN', { system: { 'nav.next': 'आगे' } }, { fallback: EN_IN });
    expect(hi.t('system:nav.next')).toBe('आगे');
    expect(hi.t('system:nav.back')).toBe('Back');
    expect(hi.missing('system', ['nav.next', 'nav.back'])).toEqual(['nav.back']);
    expect(hi.has('system:nav.back')).toBe(true);
    expect(hi.formatNumber(1234567)).toBe('12,34,567');
  });

  it('takes month and am/pm names from the system catalogue', () => {
    const hi = createI18n('hi-IN', { system: { 'date.month_short.9': 'सित॰', 'time.pm': 'अपराह्न' } }, { fallback: EN_IN });
    expect(hi.formatDate('2026-09-05', 'D MMM YYYY')).toBe('5 सित॰ 2026');
    expect(hi.formatDateTime('2026-09-05T18:45', 'DD-MM-YYYY', 'h12')).toBe('05-09-2026, 6:45 अपराह्न');
  });

  it('formats every en-IN catalogue message', () => {
    const onError = vi.fn();
    const strict = createI18n('en-IN', EN_IN, { onError });
    for (const { id, source } of allMessages) expect(strict.t(id, sampleValues(source))).not.toBe(id);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('createI18n (en-XA pseudo-locale)', () => {
  const xa = createI18n('en-XA', EN_IN);

  it('accents, pads and wraps messages while keeping arguments and plurals', () => {
    expect(xa.formatLocale).toBe('en-IN');
    const next = xa.t('system:nav.next');
    expect(next.startsWith(PSEUDO_OPEN) && next.endsWith(PSEUDO_CLOSE)).toBe(true);
    expect(next).toContain('Ñéẋţ');
    expect(xa.t('system:too_short', { min: 1 })).toMatch(/^⟦Éñţéŕ áţ ļéášţ 1 çĥáŕáçţéŕ\.·+⟧$/);
    expect(xa.t('system:resume.link_sent', { email: 'a@b.in' })).toContain('a@b.in');
    expect(xa.t('system:progress.label', { current: 1234567, total: 2 })).toContain('12,34,567');
  });

  it('wraps every catalogue message so nothing renders unwrapped', () => {
    for (const { id, source } of allMessages) {
      const out = xa.t(id, sampleValues(source));
      expect(out.startsWith(PSEUDO_OPEN) && out.endsWith(PSEUDO_CLOSE), id).toBe(true);
      expect(findUnwrappedText(out), id).toEqual([]);
    }
  });

  it('pseudo-localises date names but not digits', () => {
    expect(xa.formatDate('2026-09-05', 'DD-MM-YYYY')).toBe('05-09-2026');
    const long = xa.formatDate('2026-09-05', 'MMMM D, YYYY');
    expect(long).toMatch(/^⟦Šéþţéɱƀéŕ·+⟧ 5, 2026$/);
    expect(findUnwrappedText(long)).toEqual([]);
  });

  it('pseudo-localises messages declared in code', () => {
    const m = defineMessages('renderer', { 'upload.remove': 'Remove {name}' });
    const local = createI18n('en-XA', { renderer: { 'upload.remove': 'Remove {name}' } });
    expect(local.t(m['upload.remove'], { name: 'cv.pdf' })).toMatch(/^⟦Ŕéɱóṽé cv\.pdf·+⟧$/);
  });
});

describe('findUnwrappedText', () => {
  it('reports letters outside the pseudo markers', () => {
    expect(findUnwrappedText('⟦Ñéẋţ⟧ 12,34,567 05-09-2026 ⟦Ɓáçķ⟧')).toEqual([]);
    expect(findUnwrappedText('⟦Ñéẋţ⟧ Submit ⟦Ɓáçķ⟧ (2)')).toEqual(['Submit']);
    expect(findUnwrappedText('⟦Çļíçķ ⟦ĥéŕé⟧ ñóŵ⟧Hard-coded')).toEqual(['Hard-coded']);
    expect(findUnwrappedText('नमस्ते')).toEqual(['नमस्ते']);
  });

  it('allows formatted money in any currency under en-XA', () => {
    const xa = createI18n('en-XA', EN_IN);
    const prices = ['123456', '-99', '0'].flatMap((minor) =>
      ['INR', 'USD', 'EUR', 'JPY', 'KWD', 'CHF'].map((currency) => xa.formatMoney(minor, currency)),
    );
    expect(prices).toContain('US$1,234.56');
    expect(prices).toContain('JPY 1,23,456');
    expect(findUnwrappedText(`⟦Ţóţáļ⟧ ${prices.join(' ')}`)).toEqual([]);
    expect(findUnwrappedText(`${xa.formatMoney('100', 'USD')} USD only`)).toEqual(['US$1.00 USD only']);
  });
});
