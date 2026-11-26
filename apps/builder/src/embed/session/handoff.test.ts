import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ticketFx from '@/embed/contract/__fixtures__/launch-ticket.fixtures.json' with { type: 'json' };
import { resetLaunchMemo } from '@/embed/launch';
import { clearHandoffStorage, readResume, takeHandoff, writeResume, type HandoffEnv } from './handoff';
import { startLaunch } from './launchFlow';
import { testEnv } from './testing';

/*
 * T-DMSINT-52 (SEC-DESIGN 10.3): the hand-off in a PRODUCTION build. A `#fp=` v1 descriptor is refused ("no longer supported"), `&fpv`
 * is ignored, an unlisted `&api` is refused, and in every one of those cases no request is made. The fragment is gone from the address
 * bar before anything else happens, the verifier is read once, and the resume hint is validated like any untrusted input.
 */

const { ticket: TICKET, verifier: VERIFIER } = ticketFx.samples;
const BASE = 'https://dms.example.test/api';
const PROD: HandoffEnv = testEnv(BASE);
const DEV: HandoffEnv = { ...PROD, devOverrides: true };
const OTHER = 'FHaeCvolLOslNYadYQ48jySIoprjWCPOp0T6keQZStX';

const at = (hash: string) => window.history.replaceState(null, '', `/embed/dms-master${hash}`);
const requestsOf = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.length;

beforeEach(() => {
  resetLaunchMemo();
  clearHandoffStorage();
  at('');
});
afterEach(() => vi.unstubAllEnvs());

describe('T-DMSINT-52 takeHandoff, production build', () => {
  it('refuses a #fp= v1 descriptor as no longer supported, strips it, and makes no request', async () => {
    at('#fp=eyJ2IjoxLCJtb2RlIjoiZG1zLW1hc3RlciJ9');
    const fetch = vi.fn();
    const outcome = await startLaunch('dms-master', { env: PROD, fetch: fetch as never });
    expect(outcome).toEqual({ kind: 'failed', reason: 'legacy_descriptor' });
    expect(window.location.hash).toBe('');
    expect(requestsOf(fetch)).toBe(0);
  });

  it('ignores &fpv: the verifier is the one the DMS page stored in sessionStorage, never one the link carries', () => {
    sessionStorage.setItem('fp.lv', VERIFIER);
    at(`#fpt=${TICKET}&fpv=${OTHER}`);
    const h = takeHandoff(PROD);
    expect(h).toEqual({ kind: 'ticket', ticket: TICKET, verifier: VERIFIER, apiBase: BASE });
  });

  it('with only &fpv and no stored verifier there is no verifier: refused, and no request is made', async () => {
    at(`#fpt=${TICKET}&fpv=${VERIFIER}`);
    const fetch = vi.fn();
    const outcome = await startLaunch('dms-master', { env: PROD, fetch: fetch as never });
    expect(outcome).toEqual({ kind: 'failed', reason: 'no_verifier' });
    expect(requestsOf(fetch)).toBe(0);
  });

  it('refuses an &api that is not listed, with one base and with several, and makes no request', async () => {
    const evil = encodeURIComponent('https://evil.example.test/api');
    for (const env of [PROD, { ...PROD, apiBases: [BASE, 'https://dms2.example.test/api'] }]) {
      resetLaunchMemo();
      sessionStorage.setItem('fp.lv', VERIFIER);
      at(`#fpt=${TICKET}&api=${evil}`);
      const fetch = vi.fn();
      expect(await startLaunch('dms-master', { env, fetch: fetch as never })).toEqual({ kind: 'failed', reason: 'api_not_allowed' });
      expect(requestsOf(fetch)).toBe(0);
    }
  });

  it('with several bases the link must name one: sending the verifier to a base the link did not choose could hand it to another server', () => {
    const env = { ...PROD, apiBases: [BASE, 'https://dms2.example.test/api'] };
    sessionStorage.setItem('fp.lv', VERIFIER);
    at(`#fpt=${TICKET}`);
    expect(takeHandoff(env)).toEqual({ kind: 'failed', reason: 'api_not_allowed' });
    sessionStorage.setItem('fp.lv', VERIFIER);
    at(`#fpt=${TICKET}&api=${encodeURIComponent('https://dms2.example.test/api/')}`);
    expect(takeHandoff(env)).toMatchObject({ kind: 'ticket', apiBase: 'https://dms2.example.test/api' });
  });

  it('with no API base configured nothing can be exchanged', () => {
    sessionStorage.setItem('fp.lv', VERIFIER);
    at(`#fpt=${TICKET}`);
    expect(takeHandoff({ ...PROD, apiBases: [] })).toEqual({ kind: 'failed', reason: 'api_not_allowed' });
  });

  it('removes the fragment from the address bar BEFORE the exchange request is sent, and reads fp.lv once', async () => {
    sessionStorage.setItem('fp.lv', VERIFIER);
    at(`#fpt=${TICKET}`);
    const seen: Array<{ hash: string; lv: string | null }> = [];
    const fetch = vi.fn(async () => {
      seen.push({ hash: window.location.hash, lv: sessionStorage.getItem('fp.lv') });
      return new Response('{}', { status: 401 });
    });
    await startLaunch('dms-master', { env: PROD, fetch: fetch as never });
    expect(seen).toEqual([{ hash: '', lv: null }]);
    expect(window.location.href).not.toContain('fpt');
  });

  it('strips a fragment it refuses too, and an unrelated fragment', () => {
    at('#fpt=garbage');
    expect(takeHandoff(PROD)).toEqual({ kind: 'failed', reason: 'malformed' });
    expect(window.location.hash).toBe('');
    at('#x=1');
    expect(takeHandoff(PROD)).toEqual({ kind: 'failed', reason: 'missing' });
    expect(window.location.hash).toBe('');
  });

  it('does not reuse a verifier: the second read finds none', () => {
    sessionStorage.setItem('fp.lv', VERIFIER);
    at(`#fpt=${TICKET}`);
    expect(takeHandoff(PROD)).toMatchObject({ kind: 'ticket' });
    at(`#fpt=${TICKET}`);
    expect(takeHandoff(PROD)).toEqual({ kind: 'failed', reason: 'no_verifier' });
  });

  it('refuses a stored verifier that is not 43 base64url characters', () => {
    sessionStorage.setItem('fp.lv', 'short');
    at(`#fpt=${TICKET}`);
    expect(takeHandoff(PROD)).toEqual({ kind: 'failed', reason: 'no_verifier' });
  });

  it('copes with storage that throws (a blocked-storage browser): no verifier, refused', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    at(`#fpt=${TICKET}`);
    expect(takeHandoff(PROD)).toEqual({ kind: 'failed', reason: 'no_verifier' });
    spy.mockRestore();
  });
});

describe('takeHandoff, dev build (VITE_FP_DEV_OVERRIDES=1)', () => {
  it('honours &fpv when there is no stored verifier', () => {
    at(`#fpt=${TICKET}&fpv=${VERIFIER}`);
    expect(takeHandoff(DEV)).toEqual({ kind: 'ticket', ticket: TICKET, verifier: VERIFIER, apiBase: BASE });
  });
  it('refuses a malformed &fpv', () => {
    at(`#fpt=${TICKET}&fpv=short`);
    expect(takeHandoff(DEV)).toEqual({ kind: 'failed', reason: 'malformed' });
  });
});

describe('takeHandoff, M2 legacy build (VITE_FP_LEGACY_DESCRIPTOR=1)', () => {
  it('hands a #fp= descriptor to the legacy modules instead of refusing it', () => {
    at('#fp=abc');
    expect(takeHandoff({ ...PROD, legacyDescriptor: true })).toEqual({ kind: 'legacy', fragment: 'abc' });
  });
});

describe('the contract fragment cases, through takeHandoff', () => {
  for (const c of ticketFx.fragments) {
    const { hash, apiBases, devOverrides } = c.input;
    it(c.name, () => {
      const env: HandoffEnv = { ...PROD, apiBases, devOverrides };
      sessionStorage.setItem('fp.lv', VERIFIER);
      at(hash.startsWith('#') ? hash : `#${hash}`);
      const h = takeHandoff(env);
      if (c.expect.valid) {
        expect(h).toMatchObject({ kind: 'ticket', ticket: c.expect.ticket });
      } else if (c.expect.reason === 'legacy_descriptor') {
        expect(h).toEqual({ kind: 'failed', reason: 'legacy_descriptor' });
      } else if (c.expect.reason === 'missing') {
        expect(h.kind).toBe('failed');
      } else {
        expect(h).toEqual({ kind: 'failed', reason: c.expect.reason });
      }
    });
  }
});

describe('the resume hint (fp.resume)', () => {
  const hint = {
    mode: 'dms-master' as const,
    master_id: 'a1000000-0000-4000-8000-000000000001',
    record_id: null,
    reconnect_url: 'https://dms.example.test/dms/t1/formplus/reconnect',
    return_url: 'https://dms.example.test/dms/t1/documents/master',
  };

  it('a reload with a hint and no fragment is a resume: no ticket, no request', async () => {
    writeResume(hint);
    const fetch = vi.fn();
    const outcome = await startLaunch('dms-master', { env: PROD, fetch: fetch as never });
    expect(outcome).toEqual({ kind: 'resume', hint });
    expect(requestsOf(fetch)).toBe(0);
  });

  it('holds no credential, ticket or verifier: exactly the five non-secret keys', () => {
    writeResume(hint);
    const stored = JSON.parse(sessionStorage.getItem('fp.resume') ?? 'null') as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['master_id', 'mode', 'reconnect_url', 'record_id', 'return_url']);
    expect(JSON.stringify(stored)).not.toMatch(/fps1_|fpt1_/);
  });

  it('is re-validated on read: another origin, an http URL on an https page, an unknown mode, an extra key or a bad id all drop it', () => {
    const bad: Array<Record<string, unknown>> = [
      { ...hint, reconnect_url: 'https://evil.example.test/dms/x' },
      { ...hint, return_url: 'javascript:alert(1)' },
      { ...hint, mode: 'dms-upload' },
      { ...hint, master_id: 'not-a-uuid' },
      { ...hint, extra: 1 },
      { mode: 'dms-master' },
    ];
    for (const b of bad) {
      sessionStorage.setItem('fp.resume', JSON.stringify(b));
      expect(readResume(PROD)).toBeNull();
    }
    sessionStorage.setItem('fp.resume', 'not json');
    expect(readResume(PROD)).toBeNull();
    sessionStorage.setItem('fp.resume', JSON.stringify(hint));
    expect(readResume(PROD)).toEqual(hint);
  });

  it('a hint for another mode does not resume this page', async () => {
    writeResume({ ...hint, mode: 'dms-record', record_id: null });
    expect(await startLaunch('dms-master', { env: PROD, fetch: vi.fn() as never })).toEqual({ kind: 'failed', reason: 'wrong_mode' });
  });

  it('with neither a fragment nor a hint the page was not opened from DMS', async () => {
    expect(await startLaunch('dms-master', { env: PROD, fetch: vi.fn() as never })).toEqual({ kind: 'failed', reason: 'missing' });
  });
});
