import { describe, expect, it } from 'vitest';
import { embedEnv, parseEmbedParents, resolveParent } from './origins.ts';

const OWN = 'https://form.example';
const env = (parents: string[]) => ({ parents });

describe('embed parent allowlist', () => {
  it('defaults to this origin when unset or when no entry is usable', () => {
    expect(parseEmbedParents(undefined, OWN)).toEqual([OWN]);
    expect(parseEmbedParents('', OWN)).toEqual([OWN]);
    expect(parseEmbedParents('*, javascript:alert(1), ftp://x.example', OWN)).toEqual([OWN]);
  });

  it('normalises listed origins, drops duplicates and credentials', () => {
    expect(parseEmbedParents('https://dms.example/, https://dms.example, http://192.168.1.54:3000/path, https://u:p@evil.example', OWN)).toEqual(['https://dms.example', 'http://192.168.1.54:3000']);
  });

  it('reads fp_v from the query', () => {
    expect(embedEnv('?fp_v=1', OWN, undefined).version).toBe('1');
    expect(embedEnv('', OWN, undefined).version).toBeNull();
  });
});

describe('resolveParent', () => {
  const allowed = env(['https://dms.example', 'http://localhost:3000']);

  it('accepts an allowlisted origin, with or without a trailing slash, encoded or not', () => {
    expect(resolveParent('?fp_parent=https%3A%2F%2Fdms.example&fp_v=1', allowed)).toEqual({ ok: true, parentOrigin: 'https://dms.example' });
    expect(resolveParent('?fp_parent=http://localhost:3000/', allowed)).toEqual({ ok: true, parentOrigin: 'http://localhost:3000' });
  });

  it('refuses an origin that is not listed, including lookalikes and other ports or schemes', () => {
    for (const parent of ['https://evil.example', 'https://dms.example.evil.example', 'http://dms.example', 'https://dms.example:8443', 'https://dms.example@evil.example']) {
      expect(resolveParent(`?fp_parent=${encodeURIComponent(parent)}`, allowed).ok, parent).toBe(false);
    }
  });

  it('says why: missing, malformed (not a bare origin) or not allowed', () => {
    expect(resolveParent('', allowed)).toEqual({ ok: false, reason: 'missing' });
    expect(resolveParent('?fp_parent=', allowed)).toEqual({ ok: false, reason: 'missing' });
    for (const parent of ['dms.example', 'javascript:alert(1)', 'https://dms.example/path', 'null', '*']) {
      expect(resolveParent(`?fp_parent=${encodeURIComponent(parent)}`, allowed), parent).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(resolveParent('?fp_parent=https%3A%2F%2Fevil.example', allowed)).toEqual({ ok: false, reason: 'not_allowed' });
  });
});
