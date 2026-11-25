import { beforeEach, describe, expect, it } from 'vitest';
import {
  currentLaunch, decodeDescriptor, encodeDescriptor, fragmentValue, parseLaunch, profileOverride, resetLaunchMemo, returnTarget, validateDescriptor,
  type LaunchDescriptor, type LaunchEnv,
} from '@/embed/launch';

const ORIGIN = 'https://dms.example.test';
const env: LaunchEnv = { origin: ORIGIN, returnOrigins: [], apiBases: [`${ORIGIN}/api`], devOverrides: false };

const descriptor = (over: Partial<LaunchDescriptor> = {}): LaunchDescriptor => ({
  v: 1,
  mode: 'dms-master',
  profile: 'dms-v1',
  tenantId: 'acme',
  workspaceId: 'ws_1',
  master: { name: 'Vendor', doctypeIds: [], folderIds: [] },
  returnUrl: `${ORIGIN}/dms-v2/acme/metadata`,
  apiBase: `${ORIGIN}/api/`,
  ...over,
});

const hash = (d: unknown) => `#fp=${encodeDescriptor(d as LaunchDescriptor)}`;

describe('descriptor codec', () => {
  it('round-trips base64url JSON, including non-ASCII names', () => {
    const d = descriptor({ master: { name: 'Zürich Büro 京都', doctypeIds: [], folderIds: [] } });
    const encoded = encodeDescriptor(d);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeDescriptor(encoded)).toEqual(d);
  });
  it('refuses anything that is not base64url', () => {
    expect(() => decodeDescriptor('not base64!')).toThrow();
    expect(() => decodeDescriptor('a'.repeat(20_000))).toThrow();
    expect(() => decodeDescriptor('e30=extra')).toThrow();
  });
  it('reads the fp value of a fragment', () => {
    expect(fragmentValue('#fp=abc&x=1')).toBe('abc');
    expect(fragmentValue('#x=1')).toBeNull();
    expect(fragmentValue('')).toBeNull();
  });
});

describe('validateDescriptor', () => {
  it('accepts a good descriptor and normalises the API base (no trailing slash) and the return URL', () => {
    const r = parseLaunch(hash(descriptor()), 'dms-master', env);
    expect(r).toMatchObject({ ok: true, launch: { apiBase: `${ORIGIN}/api`, returnUrl: `${ORIGIN}/dms-v2/acme/metadata`, tenantId: 'acme', profile: 'dms-v1' } });
  });

  it('accepts a root-relative API base (the dev rewrite on the DMS host)', () => {
    const r = validateDescriptor(descriptor({ apiBase: '/api' }), 'dms-master', env);
    expect(r).toMatchObject({ ok: true, launch: { apiBase: `${ORIGIN}/api` } });
  });

  it('refuses a descriptor for another mode, another profile, another version, or with extra keys', () => {
    expect(validateDescriptor(descriptor({ mode: 'dms-record' }), 'dms-master', env)).toMatchObject({ ok: false, reason: 'wrong_mode' });
    expect(validateDescriptor({ ...descriptor(), profile: 'full' }, 'dms-master', env)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(validateDescriptor({ ...descriptor(), v: 2 }, 'dms-master', env)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(validateDescriptor({ ...descriptor(), token: 'x' }, 'dms-master', env)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(validateDescriptor('nope', 'dms-master', env)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses ids that could smuggle characters into a header, and a masterId that is not a uuid', () => {
    expect(validateDescriptor(descriptor({ tenantId: 'a\r\nX-Evil: 1' }), 'dms-master', env).ok).toBe(false);
    expect(validateDescriptor(descriptor({ workspaceId: '' }), 'dms-master', env).ok).toBe(false);
    expect(validateDescriptor(descriptor({ masterId: '1; drop' }), 'dms-master', env).ok).toBe(false);
    expect(validateDescriptor(descriptor({ masterId: 'b1000000-0000-4000-8000-000000000001' }), 'dms-master', env).ok).toBe(true);
  });

  describe('apiBase allowlist (the token goes only here)', () => {
    it('refuses an origin that is not this page or on the list', () => {
      const r = validateDescriptor(descriptor({ apiBase: 'https://evil.example.test/api' }), 'dms-master', env);
      expect(r).toMatchObject({ ok: false, reason: 'api_origin_rejected', detail: 'https://evil.example.test/api' });
    });
    it('accepts a configured base, matched exactly (trailing slash in the descriptor is fine)', () => {
      const listed: LaunchEnv = { ...env, apiBases: ['https://api.dms.example.test/v1'] };
      expect(validateDescriptor(descriptor({ apiBase: 'https://api.dms.example.test/v1/' }), 'dms-master', listed)).toMatchObject({ ok: true, launch: { apiBase: 'https://api.dms.example.test/v1' } });
    });
    it('refuses a different path on an allowed origin (the token must not go to /files/public/...)', () => {
      expect(validateDescriptor(descriptor({ apiBase: `${ORIGIN}/files/public/attacker-bucket` }), 'dms-master', env)).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
      expect(validateDescriptor(descriptor({ apiBase: `${ORIGIN}/api/sub` }), 'dms-master', env)).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
      expect(validateDescriptor(descriptor({ apiBase: `${ORIGIN}/api?x=1` }), 'dms-master', env)).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
      const listed: LaunchEnv = { ...env, apiBases: ['https://gw.example/dms'] };
      expect(validateDescriptor(descriptor({ apiBase: 'https://gw.example/some-other-service' }), 'dms-master', listed)).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
    });
    it('refuses everything when no base is configured', () => {
      expect(validateDescriptor(descriptor(), 'dms-master', { ...env, apiBases: [] })).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
    });
    it('a descriptor carrying a classification is invalid (the link does not choose it)', () => {
      const d = { ...descriptor(), master: { name: 'V', doctypeIds: [], folderIds: [], classification: 'attacker-chosen' } };
      expect(validateDescriptor(d, 'dms-master', env)).toMatchObject({ ok: false, reason: 'invalid' });
    });
    it('a dms-ui shaped create descriptor with classification: null is accepted', () => {
      const d = { ...descriptor(), master: { name: 'Vendor', doctypeIds: [], folderIds: [], classification: null } };
      expect(validateDescriptor(d, 'dms-master', env)).toMatchObject({ ok: true });
    });
    it.each(['javascript:alert(1)', 'ftp://dms.example.test/api', 'https://user:pw@dms.example.test/api', 'data:text/html,x', '//evil.example.test/api', 'https://dms.example.test.evil.test/api'])('refuses %s', (apiBase) => {
      expect(validateDescriptor(descriptor({ apiBase }), 'dms-master', env)).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
    });
  });

  describe('returnUrl allowlist (no open redirect)', () => {
    it.each(['https://evil.example.test/', 'javascript:alert(1)', 'data:text/html,x', 'https://user:pw@dms.example.test/x', '//evil.example.test/x', 'not a url'])('drops %s to null and still opens', (returnUrl) => {
      const r = validateDescriptor(descriptor({ returnUrl }), 'dms-master', env);
      expect(r).toMatchObject({ ok: true, launch: { returnUrl: null } });
    });
    it('keeps a listed origin', () => {
      const listed: LaunchEnv = { ...env, returnOrigins: ['https://app.example.test'] };
      expect(validateDescriptor(descriptor({ returnUrl: 'https://app.example.test/back?x=1' }), 'dms-master', listed)).toMatchObject({ ok: true, launch: { returnUrl: 'https://app.example.test/back?x=1' } });
    });
  });

  it('reports a missing or malformed fragment', () => {
    expect(parseLaunch('', 'dms-master', env)).toEqual({ ok: false, reason: 'missing' });
    expect(parseLaunch('#fp=@@@', 'dms-master', env)).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLaunch(`#fp=${btoa('not json').replace(/=+$/, '')}`, 'dms-master', env)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('returnTarget', () => {
  it('appends the outcome and keeps the existing query', () => {
    expect(returnTarget('https://dms.example.test/m?tab=2', 'saved', 'abc')).toBe('https://dms.example.test/m?tab=2&fp_status=saved&fp_master_id=abc');
    expect(returnTarget('https://dms.example.test/m', 'cancelled')).toBe('https://dms.example.test/m?fp_status=cancelled');
  });
});

describe('currentLaunch', () => {
  beforeEach(() => {
    resetLaunchMemo();
    window.history.replaceState(null, '', '/embed/dms-master');
  });
  const here = (h: string) => ({ hash: h, pathname: '/embed/dms-master', search: '?a=1' });

  it('parses the fragment once, clears it from the address bar, and remembers the result for a remount or reload', () => {
    const envHere: LaunchEnv = { ...env, origin: window.location.origin, apiBases: [`${window.location.origin}/api`] };
    const d = descriptor({ returnUrl: `${window.location.origin}/back`, apiBase: `${window.location.origin}/api` });
    window.history.replaceState(null, '', `/embed/dms-master${hash(d)}`);
    const first = currentLaunch('dms-master', envHere, { hash: window.location.hash, pathname: '/embed/dms-master', search: '' });
    expect(first.ok).toBe(true);
    expect(window.location.hash).toBe('');
    // StrictMode remount: no fragment any more.
    expect(currentLaunch('dms-master', envHere, here(''))).toEqual(first);
    // Reload: the module memo is gone, the tab's storage is not.
    resetLaunchMemoOnly();
    expect(currentLaunch('dms-master', envHere, here(''))).toEqual(first);
  });

  it('does not remember a descriptor that failed validation', () => {
    const bad = hash(descriptor({ apiBase: 'https://evil.example.test' }));
    expect(currentLaunch('dms-master', env, here(bad))).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
    expect(currentLaunch('dms-master', env, here(''))).toEqual({ ok: false, reason: 'missing' });
  });

  it('re-validates what it kept (storage is untrusted too)', () => {
    sessionStorage.setItem('fp.launch.dms-master', encodeDescriptor(descriptor({ apiBase: 'https://evil.example.test' })));
    expect(currentLaunch('dms-master', env, here(''))).toMatchObject({ ok: false, reason: 'api_origin_rejected' });
  });

  it('works without storage', () => {
    const spy = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')!;
    Object.defineProperty(globalThis, 'sessionStorage', { get: () => { throw new Error('blocked'); }, configurable: true });
    try {
      expect(currentLaunch('dms-master', env, here(hash(descriptor()))).ok).toBe(true);
      expect(currentLaunch('dms-master', env, here(''))).toMatchObject({ ok: true });
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', spy);
    }
  });
});

function resetLaunchMemoOnly() {
  const saved = Object.entries(sessionStorage);
  resetLaunchMemo();
  for (const [k, v] of saved) sessionStorage.setItem(k, v);
}

describe('profileOverride (dev only)', () => {
  it('is ignored unless the build allows overrides', () => {
    expect(profileOverride('?fp_profile=dms-v1', env)).toBeNull();
    expect(profileOverride('?fp_profile=full', env)).toBeNull();
  });
  it('is honoured in a dev build, for the two known profiles only', () => {
    const dev = { ...env, devOverrides: true };
    expect(profileOverride('?fp_profile=dms-v1', dev)).toBe('dms-v1');
    expect(profileOverride('?fp_profile=full', dev)).toBe('full');
    expect(profileOverride('?fp_profile=other', dev)).toBeNull();
    expect(profileOverride('', dev)).toBeNull();
  });
});
