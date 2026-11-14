import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiUnreachable } from '@/auth/client';
import { OrgRequired, SignInRequired, publishLive } from '@/persistence/publishApi';

const orgApi = vi.fn();
const loadSession = vi.fn();
const putDraft = vi.fn();

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return {
    ...actual,
    orgApi: (...args: unknown[]) => orgApi(...args),
    loadSession: () => loadSession(),
  };
});

vi.mock('@/persistence/draftsApi', () => ({
  putRemoteDraftForPublish: (...args: unknown[]) => putDraft(...args),
}));

const live = { slug: 'live-form', versionId: 'v1', number: 1 };
const ME = { user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false }, session: null, orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }], activeOrgId: 'o1' };
const signedIn = { status: 'signed_in', me: ME };

describe('publishLive', () => {
  beforeEach(() => {
    orgApi.mockReset();
    loadSession.mockReset();
    putDraft.mockReset();
    sessionStorage.clear();
  });

  it('saves the draft to the active org, then publishes it on the org route', async () => {
    loadSession.mockResolvedValue(signedIn);
    orgApi.mockResolvedValue(live);
    await expect(publishLive('f1', { title: 'Hi' }, 'Hi')).resolves.toEqual(live);
    expect(putDraft).toHaveBeenCalledWith('f1', { title: 'Hi' }, 'Hi');
    expect(orgApi).toHaveBeenCalledWith('POST', '/v1/forms/f1/publish', expect.anything(), {});
    expect(orgApi.mock.calls.every(([, path]) => !String(path).startsWith('/v1/p/'))).toBe(true);
    expect(sessionStorage.getItem('fr.live.f1')).toBe('live-form');
  });

  it('never publishes anonymously: signed out means sign in, and nothing is sent', async () => {
    loadSession.mockResolvedValue({ status: 'signed_out' });
    await expect(publishLive('f1', { title: 'Hi' }, 'Hi')).rejects.toBeInstanceOf(SignInRequired);
    expect(putDraft).not.toHaveBeenCalled();
    expect(orgApi).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('fr.live.f1')).toBeNull();
  });

  it('asks for an organisation when the account has none', async () => {
    loadSession.mockResolvedValue({ status: 'signed_in', me: { ...ME, orgs: [], activeOrgId: null } });
    await expect(publishLive('f1', {}, 'Hi')).rejects.toBeInstanceOf(OrgRequired);
    expect(orgApi).not.toHaveBeenCalled();
  });

  it('reports an unreachable API as such, not as a sign-in', async () => {
    loadSession.mockResolvedValue({ status: 'unreachable' });
    await expect(publishLive('f1', {}, 'Hi')).rejects.toBeInstanceOf(ApiUnreachable);
  });
});
