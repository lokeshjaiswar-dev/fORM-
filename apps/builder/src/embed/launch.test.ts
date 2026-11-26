import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ticketFx from '@/embed/contract/__fixtures__/launch-ticket.fixtures.json' with { type: 'json' };
import returnFx from '@/embed/contract/__fixtures__/formplus-return.fixtures.json' with { type: 'json' };
import { parseReturnParams } from '@/embed/contract';
import { currentLaunch, decodeDescriptor, encodeDescriptor, profileOverride, rememberMasterId, resetLaunchMemo, returnTarget, type LaunchDescriptor, type LaunchEnv } from '@/embed/launch';
import { readResume } from '@/embed/session/handoff';
import { installTestSession, resetTestSession, TEST_API_BASE, testEnv } from '@/embed/session/testing';

const ORIGIN = 'https://dms.example.test';
const env: LaunchEnv = { origin: ORIGIN, returnOrigins: [], apiBases: [`${ORIGIN}/api`], devOverrides: false };
const MASTER = 'a1000000-0000-4000-8000-000000000001';

beforeEach(() => resetLaunchMemo());
afterEach(() => {
  resetTestSession();
  vi.unstubAllEnvs();
});

describe('descriptor codec (the legacy link format, kept for DMS-side tests)', () => {
  const d: LaunchDescriptor = { v: 1, mode: 'dms-master', profile: 'dms-v1', tenantId: 'acme', workspaceId: 'ws_1', master: { name: 'Zürich Büro 京都', doctypeIds: [], folderIds: [] }, returnUrl: `${ORIGIN}/x`, apiBase: `${ORIGIN}/api` };
  it('round-trips base64url JSON, including non-ASCII names', () => {
    const encoded = encodeDescriptor(d);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeDescriptor(encoded)).toEqual(d);
  });
  it('refuses anything that is not base64url', () => {
    expect(() => decodeDescriptor('not base64!')).toThrow();
    expect(() => decodeDescriptor('a'.repeat(20_000))).toThrow();
    expect(() => decodeDescriptor('e30=extra')).toThrow();
  });
});

describe('returnTarget (contract formplus-return)', () => {
  it('appends the outcome and keeps the existing query', () => {
    expect(returnTarget('https://dms.example.test/m?tab=2', 'saved', 'abc')).toBe('https://dms.example.test/m?tab=2&fp_status=saved&fp_master_id=abc');
    expect(returnTarget('https://dms.example.test/m', 'cancelled')).toBe('https://dms.example.test/m?fp_status=cancelled');
  });

  it('error carries fp_code (and the master when there is one); fp_code is only ever sent with error', () => {
    expect(returnTarget('https://dms.example.test/m', 'error', undefined, 'FORBIDDEN_RIGHT')).toBe('https://dms.example.test/m?fp_status=error&fp_code=FORBIDDEN_RIGHT');
    expect(returnTarget('https://dms.example.test/m', 'error', MASTER, 'NOT_FOUND')).toBe(`https://dms.example.test/m?fp_status=error&fp_master_id=${MASTER}&fp_code=NOT_FOUND`);
    expect(returnTarget('https://dms.example.test/m', 'saved', MASTER, 'NOT_FOUND')).toBe(`https://dms.example.test/m?fp_status=saved&fp_master_id=${MASTER}`);
  });

  it('leaves out an id or code that does not match its pattern, instead of sending it', () => {
    expect(returnTarget('https://dms.example.test/m', 'error', 'a b&c', 'not a code')).toBe('https://dms.example.test/m?fp_status=error');
  });

  it('what it builds parses with the contract rule DMS applies', () => {
    for (const [status, id, code] of [['saved', MASTER, undefined], ['cancelled', undefined, undefined], ['error', MASTER, 'FP_SCOPE_DENIED']] as const) {
      const url = new URL(returnTarget('https://dms.example.test/m', status, id, code));
      expect(parseReturnParams(url.search)).toMatchObject({ fp_status: status });
    }
    expect(returnFx.cases.length).toBeGreaterThan(0);
  });
});

describe('currentLaunch (built from the exchange context)', () => {
  it('is missing until the session is launched, and a #fp= link never makes one', () => {
    window.history.replaceState(null, '', '/embed/dms-master#fp=eyJ2IjoxfQ');
    expect(currentLaunch('dms-master', env)).toEqual({ ok: false, reason: 'missing' });
    window.history.replaceState(null, '', '/');
  });

  it('a master create: the seed becomes `master` incl. the classification, tenant and workspace are display values, apiBase is the session\'s', () => {
    const ctx = installTestSession();
    const r = currentLaunch('dms-master');
    expect(r).toMatchObject({
      ok: true,
      launch: {
        v: 1,
        mode: 'dms-master',
        profile: 'dms-v1',
        tenantId: ctx.tenant_id,
        workspaceId: ctx.workspace_id,
        master: { name: 'Vendor', doctypeIds: ['e1000000-0000-4000-8000-000000000001'], folderIds: ['f1000000-0000-4000-8000-000000000001'], classification: 'confidential' },
        apiBase: TEST_API_BASE,
        returnUrl: ctx.return_url,
      },
    });
    expect(r.ok && r.launch.masterId).toBeUndefined();
  });

  it('a master edit has masterId and no seed; a record has masterId and recordId', () => {
    installTestSession({ context: { master_id: MASTER, master_seed: null } });
    expect(currentLaunch('dms-master')).toMatchObject({ ok: true, launch: { masterId: MASTER } });
    expect((currentLaunch('dms-master') as { launch: { master?: unknown } }).launch.master).toBeUndefined();
    resetTestSession();
    installTestSession({ context: { mode: 'dms-record', master_id: MASTER, record_id: 'rec-1', master_seed: null } });
    expect(currentLaunch('dms-record')).toMatchObject({ ok: true, launch: { mode: 'dms-record', masterId: MASTER, recordId: 'rec-1' } });
  });

  it('another mode than the session\'s is missing', () => {
    installTestSession();
    expect(currentLaunch('dms-record')).toEqual({ ok: false, reason: 'missing' });
  });

  it('returnUrl is null when it is not on this build\'s allowlist (the page then shows no Back to DMS)', () => {
    installTestSession();
    vi.stubEnv('VITE_FP_RETURN_ORIGINS', 'https://other.example.test');
    expect(currentLaunch('dms-master')).toMatchObject({ ok: true, launch: { returnUrl: null } });
  });

  it('is the same object while nothing changed (callers memoise on it)', () => {
    installTestSession();
    const a = currentLaunch('dms-master') as { launch: unknown };
    expect((currentLaunch('dms-master') as { launch: unknown }).launch).toBe(a.launch);
  });
});

describe('rememberMasterId', () => {
  it('after a create the launch becomes "edit that master", in the context, and in the resume hint a reload uses', () => {
    installTestSession();
    expect(currentLaunch('dms-master')).toMatchObject({ ok: true, launch: {} });
    rememberMasterId('dms-master', MASTER);
    expect(currentLaunch('dms-master')).toMatchObject({ ok: true, launch: { masterId: MASTER } });
    expect(readResume(testEnv())).toMatchObject({ mode: 'dms-master', master_id: MASTER });
  });

  it('does nothing for another mode', () => {
    installTestSession();
    rememberMasterId('dms-record', MASTER);
    expect((currentLaunch('dms-master') as { launch: { masterId?: string } }).launch.masterId).toBeUndefined();
  });
});

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

describe('the contract samples used here are the fixtures', () => {
  it('the master seed of the create sample', () => {
    expect((ticketFx.exchangeResponse[0]!.input as { context: { master_seed: unknown } }).context.master_seed).toMatchObject({ name: 'Vendor', classification: 'confidential' });
  });
});
