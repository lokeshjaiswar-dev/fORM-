import type { FormDefinition } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { addressWithoutQuery, buildMeta, evaluationInstant, hostOf, MAX_SESSION_MS, withoutServerOwned } from './meta.ts';

const RECEIVED = new Date('2026-11-15T10:00:00.000Z');

describe('evaluationInstant', () => {
  it('is the moment the answers arrived when the client names no start', () => {
    expect(evaluationInstant(RECEIVED, undefined)).toEqual(RECEIVED);
    expect(evaluationInstant(RECEIVED, 'not a date')).toEqual(RECEIVED);
  });

  it('is the client start when it is within the day before the answers arrived', () => {
    expect(evaluationInstant(RECEIVED, '2026-11-15T09:30:00.000Z').toISOString()).toBe('2026-11-15T09:30:00.000Z');
  });

  it('never lets the client evaluate in the future or more than a day back', () => {
    expect(evaluationInstant(RECEIVED, '2027-01-01T00:00:00.000Z')).toEqual(RECEIVED);
    expect(evaluationInstant(RECEIVED, '2020-01-01T00:00:00.000Z').getTime()).toBe(RECEIVED.getTime() - MAX_SESSION_MS);
  });
});

describe('addressWithoutQuery', () => {
  it('keeps the origin and path and drops the query, the fragment and any credentials', () => {
    expect(addressWithoutQuery('https://forms.example/f/intake?utm_source=x&email=a%40b.c#top')).toBe('https://forms.example/f/intake');
    expect(addressWithoutQuery('http://user:secret@forms.example:8080/f/a?x=1')).toBe('http://forms.example:8080/f/a');
  });

  it('gives nothing for text that is not an http(s) address', () => {
    expect(addressWithoutQuery(undefined)).toBeUndefined();
    expect(addressWithoutQuery('javascript:alert(1)')).toBeUndefined();
    expect(addressWithoutQuery('not a url')).toBeUndefined();
    expect(addressWithoutQuery('data:text/html,<p>x</p>')).toBeUndefined();
  });
});

describe('hostOf', () => {
  it('is the host of an http(s) address, and nothing else of it', () => {
    expect(hostOf('https://news.example/post/1?token=abc')).toBe('news.example');
    expect(hostOf('https://news.example:8443/x')).toBe('news.example:8443');
    expect(hostOf('mailto:a@b.c')).toBeUndefined();
    expect(hostOf('')).toBeUndefined();
  });
});

describe('buildMeta', () => {
  it('records the language and the version number, and nothing the client did not say', () => {
    expect(buildMeta({ locale: 'en-IN', client: undefined, startedAt: undefined, receivedAt: RECEIVED, versionNumber: 3 })).toEqual({ locale: 'en-IN', versionNumber: 3 });
  });

  it('records the address without its query, the referrer as a host, the device and the time spent', () => {
    const meta = buildMeta({
      locale: 'hi',
      client: { pageUrl: 'https://forms.example/f/a?secret=1', referrer: 'https://news.example/post/1?token=2', device: 'mobile' },
      startedAt: new Date('2026-11-15T09:59:30.000Z'),
      receivedAt: RECEIVED,
      versionNumber: 2,
    });
    expect(meta).toEqual({
      locale: 'hi',
      pageUrl: 'https://forms.example/f/a',
      referrer: 'news.example',
      device: 'mobile',
      startedAt: '2026-11-15T09:59:30.000Z',
      durationMs: 30_000,
      versionNumber: 2,
    });
    expect(JSON.stringify(meta)).not.toMatch(/secret|token/);
  });

  it('leaves out an address or referrer it cannot use', () => {
    const meta = buildMeta({ locale: 'en-IN', client: { pageUrl: 'javascript:1', referrer: 'nope' }, startedAt: undefined, receivedAt: RECEIVED, versionNumber: 1 });
    expect(meta).toEqual({ locale: 'en-IN', versionNumber: 1 });
  });
});

describe('withoutServerOwned', () => {
  const block = (type: string) => ({ id: type, type, key: type });
  const definition = {
    blocks: { name: block('short_text'), source: block('hidden'), total: block('calculation'), where: block('context'), ticket: block('unique_id') },
    logic: { rules: [], variables: [] },
  } as unknown as FormDefinition;

  it('keeps the answers of blocks the respondent answers and drops the four kinds the server fills in', () => {
    const kept = withoutServerOwned(definition, { name: { type: 'short_text', value: 'A' }, source: { type: 'hidden', value: 'forged' }, total: 1, where: 2, ticket: 3 });
    expect(Object.keys(kept)).toEqual(['name']);
  });

  it('drops an id that is not a block of the form, including the ones that name object internals', () => {
    const raw = JSON.parse('{"name":1,"nope":2,"__proto__":{"polluted":true},"constructor":3,"toString":4}') as Record<string, unknown>;
    const kept = withoutServerOwned(definition, raw);
    expect(Object.keys(kept)).toEqual(['name']);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  });
});
