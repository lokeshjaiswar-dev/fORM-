import { describe, expect, it } from 'vitest';
import { PARSE_LIMITS, parseApiBody, parseApiData } from '../src/remote/index.ts';

/*
 * The parser runs on the shared API (the lookup proxy and the author route), so a hostile upstream answer must cost linear
 * time and never throw: every failure is "unparsable", which the proxy turns into its one fixed 502.
 */
const MiB = 1024 * 1024;

describe('XML and JSON parsing stay linear and bounded (review blocker: proxy DoS)', () => {
  it('1 MiB of repeated sibling elements parses (or is refused) in well under a second', () => {
    const one = '<a>1</a>';
    const xml = `<r>${one.repeat(Math.floor((MiB - 7) / one.length))}</r>`;
    const started = performance.now();
    const out = parseApiData(xml, 'xml');
    expect(performance.now() - started).toBeLessThan(1000);
    // Over the element cap: refused as unparsable, never a partial tree.
    expect(out).toBeUndefined();
  });

  it('repeated siblings under the element cap become one array, in order', () => {
    const n = 20_000;
    const xml = `<r>${'<a>1</a>'.repeat(n)}<b>x</b></r>`;
    const started = performance.now();
    const data = parseApiData(xml, 'xml') as { a: number[]; b: string };
    expect(performance.now() - started).toBeLessThan(1000);
    expect(data.a).toHaveLength(n);
    expect(data.b).toBe('x');
  });

  it('deep nesting is unparsable, not a RangeError (XML and JSON)', () => {
    const depth = 200_000;
    expect(() => parseApiBody(`${'<a>'.repeat(depth)}x${'</a>'.repeat(depth)}`, 'xml')).not.toThrow();
    expect(parseApiBody(`${'<a>'.repeat(depth)}x${'</a>'.repeat(depth)}`, 'xml').data).toBeUndefined();
    expect(parseApiData(`${'<a>'.repeat(depth)}`, 'xml')).toBeUndefined();
    expect(parseApiData(`${'['.repeat(depth)}${']'.repeat(depth)}`, 'json')).toBeUndefined();
    expect(() => parseApiBody(`${'['.repeat(depth)}${']'.repeat(depth)}`, 'json')).not.toThrow();
  });

  it('nesting up to the depth limit still parses', () => {
    const d = PARSE_LIMITS.depth;
    const xml = `${'<a>'.repeat(d)}x${'</a>'.repeat(d)}`;
    expect(parseApiData(xml, 'xml')).toBeDefined();
    expect(parseApiData(`${'<a>'.repeat(d + 1)}x${'</a>'.repeat(d + 1)}`, 'xml')).toBeUndefined();
  });

  it('an unclosed comment or declaration does not scan the rest of the body once per occurrence', () => {
    const noisy = `<r>${'<!--'.repeat(Math.floor(MiB / 4))}</r>`;
    const started = performance.now();
    expect(parseApiData(noisy, 'xml')).toBeUndefined();
    expect(parseApiData(`${'<?xml '.repeat(150_000)}<r/>`, 'xml')).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('element names that are Object.prototype keys are plain keys', () => {
    const data = parseApiData('<r><constructor>a</constructor><toString>b</toString><__proto__>c</__proto__></r>', 'xml') as Record<string, unknown>;
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(data['constructor']).toBe('a');
    expect(data['toString']).toBe('b');
    expect(Object.hasOwn(data, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps the old XML shapes: declaration and comments dropped, text coerced, repeats as arrays, self-closing as empty', () => {
    expect(parseApiData('<?xml version="1.0"?><!-- c --><r><ok>true</ok><n>3</n><i>a</i><i>b</i><e/></r>', 'xml')).toEqual({ ok: true, n: 3, i: ['a', 'b'], e: '' });
    expect(parseApiData('<v>7</v>', 'xml')).toEqual({ v: 7 });
    expect(parseApiBody('<v>7</v>', 'xml').data).toEqual({ v: 7 });
    expect(parseApiData('<r><a>1</b></r>', 'xml')).toBeUndefined();
    expect(parseApiData('not xml', 'xml')).toBeUndefined();
  });
});
