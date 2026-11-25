import { describe, expect, it } from 'vitest';
import type { WebhookPayloadMapping } from '../src/index.ts';
import { applyMapping, escapeXml, isXmlName, parsePath, renderJson, renderXml, validateMapping } from '../src/index.ts';

const meta = { event: 'submission.created', eventId: 'e1', createdAt: '2026-01-01T00:00:00.000Z', formId: 'f1', submissionId: 's1', submittedAt: '2026-01-01T00:00:01.000Z' } as const;
const answer = (path: string, key: string) => ({ path, source: { kind: 'answer' as const, key } });

describe('parsePath', () => {
  it('accepts names, dots and [] and rejects the rest', () => {
    expect(parsePath('customer.name')).toEqual([{ name: 'customer', repeat: false }, { name: 'name', repeat: false }]);
    expect(parsePath('order.lines[].item')?.[1]).toEqual({ name: 'lines', repeat: true });
    for (const bad of ['', 'a..b', 'a.0', '1a', 'a b', 'a[0]', 'a<b>', '__proto__.x', 'x.constructor', 'xmlfoo', 'a.b.c.d.e.f.g.h.i']) expect(parsePath(bad), bad).toBeNull();
  });
});

describe('validateMapping', () => {
  it('flags duplicates, leaf/parent clashes and [] mismatches', () => {
    expect(validateMapping({ entries: [answer('a.b', 'x'), answer('a.c', 'y')] })).toEqual([]);
    expect(validateMapping({ entries: [answer('a', 'x'), answer('a.b', 'y')] }).length).toBeGreaterThan(0);
    expect(validateMapping({ entries: [answer('a.b', 'x'), answer('a', 'y')] }).length).toBeGreaterThan(0);
    expect(validateMapping({ entries: [answer('a', 'x'), answer('a', 'y')] })[0]).toMatch(/twice/);
    expect(validateMapping({ entries: [answer('a[].b', 'x'), answer('a.c', 'y')] }).length).toBeGreaterThan(0);
    expect(validateMapping({ root: '1bad', entries: [] }).length).toBe(1);
    expect(validateMapping({ root: 'XMLroot', entries: [] }).length).toBe(1);
  });
});

describe('applyMapping', () => {
  it('builds nested objects from answers and meta', () => {
    const m: WebhookPayloadMapping = { entries: [answer('customer.name', 'full_name'), { path: 'ref', source: { kind: 'meta', name: 'submissionId' } }] };
    const { tree, usedKeys } = applyMapping(m, { answers: { full_name: 'Asha' }, meta });
    expect(JSON.parse(renderJson(tree))).toEqual({ customer: { name: 'Asha' }, ref: 's1' });
    expect(usedKeys).toEqual(['full_name']);
  });

  it('spreads an array over [] and merges columns by index', () => {
    const m: WebhookPayloadMapping = { entries: [answer('order.lines[].item', 'items'), answer('order.lines[].qty', 'qtys'), answer('tags[]', 'one')] };
    const { tree } = applyMapping(m, { answers: { items: ['a', 'b'], qtys: ['1', '2'], one: 'solo' }, meta });
    expect(JSON.parse(renderJson(tree))).toEqual({ order: { lines: [{ item: 'a', qty: '1' }, { item: 'b', qty: '2' }] }, tags: ['solo'] });
  });

  it('skips a field that is not in the disclosed answers', () => {
    const { tree, usedKeys } = applyMapping({ entries: [answer('secret', 'ssn'), answer('ok', 'name')] }, { answers: { name: 'x' }, meta });
    expect(JSON.parse(renderJson(tree))).toEqual({ ok: 'x' });
    expect(usedKeys).toEqual(['name']);
  });

  it('carries a masked value as it is and cannot pollute prototypes', () => {
    const { tree } = applyMapping({ entries: [answer('a.b', 'k')] }, { answers: { k: '••••••' }, meta });
    expect(JSON.parse(renderJson(tree))).toEqual({ a: { b: '••••••' } });
    expect(() => applyMapping({ entries: [answer('__proto__.polluted', 'k')] }, { answers: { k: 1 }, meta })).toThrow();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('throws on an invalid mapping', () => {
    expect(() => applyMapping({ entries: [answer('a', 'x'), answer('a.b', 'y')] }, { answers: {}, meta })).toThrow(/invalid payload mapping/);
  });
});

describe('XML', () => {
  it('renders a well-formed document and repeats array elements', () => {
    const { tree } = applyMapping({ entries: [answer('order.lines[].item', 'items')] }, { answers: { items: ['a', 'b'] }, meta });
    expect(renderXml('submission', tree)).toBe('<?xml version="1.0" encoding="UTF-8"?><submission><order><lines><item>a</item></lines><lines><item>b</item></lines></order></submission>');
  });

  it('escapes text so a value cannot inject markup, entities or a DTD', () => {
    const evil = `</x><!DOCTYPE a [<!ENTITY e SYSTEM "file:///etc/passwd">]>&e;<![CDATA[ ]]> "q" 'a'\r\n\u0000\u0001\uD800z`;
    const xml = renderXml('r', { v: evil });
    expect(xml).not.toContain('<!DOCTYPE');
    expect(xml).not.toContain('<![CDATA[');
    // oxlint-disable-next-line no-control-regex -- asserting that none are left
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><r><v>&lt;/x&gt;&lt;!DOCTYPE a [&lt;!ENTITY e SYSTEM &quot;file:///etc/passwd&quot;&gt;]&gt;&amp;e;&lt;![CDATA[ ]]&gt; &quot;q&quot; &apos;a&apos;&#13;&#10;z</v></r>',
    );
  });

  it('never lets a data key become an element name unless it is a valid one', () => {
    const xml = renderXml('r', { 'a b': '1', '<x>': '2', ok: '3', xmlns: '4', '': '5' });
    expect(xml).toContain('<item key="a b">1</item>');
    expect(xml).toContain('<item key="&lt;x&gt;">2</item>');
    expect(xml).toContain('<ok>3</ok>');
    expect(xml).toContain('<item key="xmlns">4</item>');
    expect(xml).not.toContain('<a b>');
  });

  it('rejects a bad root name and types nulls and nesting', () => {
    expect(() => renderXml('a b', {})).toThrow();
    expect(isXmlName('ok-1.x')).toBe(true);
    expect(renderXml('r', { n: null, t: true, num: 5, nested: [[1, 2]] })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><r><n/><t>true</t><num>5</num><nested><item>1</item><item>2</item></nested></r>',
    );
    expect(escapeXml('a&b')).toBe('a&amp;b');
  });
});
