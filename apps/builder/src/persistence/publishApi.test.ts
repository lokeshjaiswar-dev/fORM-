import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compile } from '@form/logic';
import { REGISTRY } from '@form/registry';
import type { FormDefinition } from '@form/schema';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { resetUi, useUiStore } from '@/state/uiStore';
import { DraftNotSaved, OrgRequired, PublishBlocked, PublishConflict, SignInRequired, checkPublishable, publishLive } from '@/persistence/publishApi';
import { block, formWith } from '@/test/fixtures';

const loadSession = vi.fn();
const orgCall = vi.fn();
const getRemoteDraft = vi.fn();
const flushAutosave = vi.fn();
const raiseDraftConflict = vi.fn();

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return { ...actual, loadSession: () => loadSession() };
});

vi.mock('@/persistence/autosave', () => ({
  flushAutosave: () => flushAutosave(),
  raiseDraftConflict: (...args: unknown[]) => raiseDraftConflict(...args),
}));

vi.mock('@/persistence/draftsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence/draftsApi')>();
  return {
    ...actual,
    orgCall: (...args: unknown[]) => orgCall(...args),
    getRemoteDraft: (...args: unknown[]) => getRemoteDraft(...args),
  };
});

const live = { slug: 'live-form', versionId: 'v1', number: 1, draftRev: 6 };
const ME = { user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false }, session: null, orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }], activeOrgId: 'o1' };
const signedIn = { status: 'signed_in', me: ME };

const doc: FormDefinition = { ...formWith([block('short_text', 'q', { label: 'Question' })]), formId: 'f1' as never };
const hashOf = (d: FormDefinition): string => {
  const built = compile(d, REGISTRY);
  if (!built.ok) throw new Error('the fixture form does not compile');
  return built.compiled.definitionHash;
};

const reply = (status: number, json: unknown) => ({ status, ok: status >= 200 && status < 300, json });

const blocked = {
  code: 'PUBLISH_BLOCKED',
  detail: 'This form has problems that must be fixed before it can be published.',
  issueCount: 3,
  issues: [
    { severity: 'error', code: 'unsafe_regex', path: '/blocks/q/config/pattern', message: 'This pattern can hang the form.' },
    { severity: 'error', code: 'invalid_url_scheme', path: '/endings/0/redirectUrl', message: 'A redirect must start with https://.' },
    { severity: 'error', code: 'logic_cycle', path: '/logic', message: 'These rules depend on each other.' },
  ],
};

describe('publishLive', () => {
  beforeEach(() => {
    for (const fn of [loadSession, orgCall, getRemoteDraft, flushAutosave, raiseDraftConflict]) fn.mockReset();
    flushAutosave.mockResolvedValue({ serverRev: 6 });
    getRemoteDraft.mockResolvedValue(null);
    sessionStorage.clear();
    resetUi();
  });

  it('saves the draft first, then publishes with expectedDraftRev and the plan hash this browser compiled', async () => {
    loadSession.mockResolvedValue(signedIn);
    orgCall.mockResolvedValue(reply(200, live));
    await expect(publishLive('f1', doc)).resolves.toEqual(live);
    expect(flushAutosave).toHaveBeenCalledTimes(1);
    expect(orgCall).toHaveBeenCalledTimes(1);
    expect(orgCall).toHaveBeenCalledWith('o1', 'POST', '/v1/forms/f1/publish', { expectedDraftRev: 6, clientDefinitionHash: hashOf(doc) });
    expect(flushAutosave.mock.invocationCallOrder[0]).toBeLessThan(orgCall.mock.invocationCallOrder[0] ?? 0);
    expect(sessionStorage.getItem('fr.live.f1')).toBe('live-form');
  });

  it('a different draft compiles to a different hash, so the server can tell a stale plan', async () => {
    loadSession.mockResolvedValue(signedIn);
    orgCall.mockResolvedValue(reply(200, live));
    const other: FormDefinition = { ...formWith([block('short_text', 'q', { label: 'Question' }), block('short_text', 'r', { label: 'Other' })]), formId: 'f1' as never };
    await publishLive('f1', other);
    const sent = orgCall.mock.calls[0]?.[3] as { clientDefinitionHash: string };
    expect(sent.clientDefinitionHash).toBe(hashOf(other));
    expect(sent.clientDefinitionHash).not.toBe(hashOf(doc));
  });

  it('turns a 422 PUBLISH_BLOCKED into PublishBlocked with the issue codes, and publishes nothing', async () => {
    loadSession.mockResolvedValue(signedIn);
    orgCall.mockResolvedValue(reply(422, blocked));
    const err = await publishLive('f1', doc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishBlocked);
    const refusal = err as PublishBlocked;
    expect(refusal.code).toBe('PUBLISH_BLOCKED');
    expect(refusal.issues.map((i) => i.code)).toEqual(['unsafe_regex', 'invalid_url_scheme', 'logic_cycle']);
    expect(refusal.issueCount).toBe(3);
    expect(sessionStorage.getItem('fr.live.f1')).toBeNull();
  });

  it('turns a 422 PLAN_MISMATCH into PublishBlocked without issues', async () => {
    loadSession.mockResolvedValue(signedIn);
    orgCall.mockResolvedValue(reply(422, { code: 'PLAN_MISMATCH', detail: 'The plan differs.' }));
    const err = await publishLive('f1', doc).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'PublishBlocked', code: 'PLAN_MISMATCH', issues: [] });
  });

  it('a 409 means the draft moved on: the merge dialog opens with the server draft and nothing is published', async () => {
    loadSession.mockResolvedValue(signedIn);
    orgCall.mockResolvedValue(reply(409, { code: 'DRAFT_REV_CONFLICT' }));
    const server = { draftRev: 8, draft: { title: 'Theirs' }, updatedAt: '2026-10-19T05:00:00.000Z' };
    getRemoteDraft.mockResolvedValue(server);
    await expect(publishLive('f1', doc)).rejects.toBeInstanceOf(PublishConflict);
    expect(getRemoteDraft).toHaveBeenCalledWith('o1', 'f1');
    expect(raiseDraftConflict).toHaveBeenCalledWith(server);
    expect(sessionStorage.getItem('fr.live.f1')).toBeNull();
  });

  it('refuses to publish an older draft than the one on screen: nothing is sent when the save did not reach the server', async () => {
    loadSession.mockResolvedValue(signedIn);
    flushAutosave.mockResolvedValue({ serverRev: null });
    const err = await publishLive('f1', doc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftNotSaved);
    expect((err as DraftNotSaved).conflict).toBe(false);
    expect(orgCall).not.toHaveBeenCalled();

    useUiStore.getState().raiseDraftConflict({ draftRev: 2, draft: {}, updatedAt: '2026-10-19T05:00:00.000Z' });
    expect(await publishLive('f1', doc).catch((e: unknown) => e)).toMatchObject({ name: 'DraftNotSaved', conflict: true });
  });

  it('never publishes anonymously: signed out means sign in, and nothing is saved or sent', async () => {
    loadSession.mockResolvedValue({ status: 'signed_out' });
    await expect(publishLive('f1', doc)).rejects.toBeInstanceOf(SignInRequired);
    expect(flushAutosave).not.toHaveBeenCalled();
    expect(orgCall).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('fr.live.f1')).toBeNull();
  });

  it('asks for an organisation when the account has none', async () => {
    loadSession.mockResolvedValue({ status: 'signed_in', me: { ...ME, orgs: [], activeOrgId: null } });
    await expect(publishLive('f1', doc)).rejects.toBeInstanceOf(OrgRequired);
    expect(orgCall).not.toHaveBeenCalled();
  });

  it('reports an unreachable API as such, not as a sign-in', async () => {
    loadSession.mockResolvedValue({ status: 'unreachable' });
    await expect(publishLive('f1', doc)).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it('passes any other refusal on as the server worded it', async () => {
    loadSession.mockResolvedValue(signedIn);
    orgCall.mockResolvedValue(reply(403, { code: 'FORBIDDEN', detail: 'Your role cannot publish.' }));
    const err = await publishLive('f1', doc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiProblem);
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('checkPublishable', () => {
  beforeEach(() => {
    for (const fn of [loadSession, orgCall, flushAutosave]) fn.mockReset();
    flushAutosave.mockResolvedValue({ serverRev: 6 });
    loadSession.mockResolvedValue(signedIn);
    resetUi();
  });

  it('saves the open document, then asks the server what would block a publish, without publishing', async () => {
    const check = { ok: false, draftRev: 6, definitionHash: null, issueCount: 1, issues: [blocked.issues[0]] };
    orgCall.mockResolvedValue(reply(200, check));
    await expect(checkPublishable('f1')).resolves.toEqual(check);
    expect(orgCall).toHaveBeenCalledWith('o1', 'POST', '/v1/forms/f1/validate', {});
    expect(orgCall.mock.calls.every(([, , path]) => !String(path).endsWith('/publish'))).toBe(true);
  });

  it('is an unreachable API when the answer is not what the server documents', async () => {
    orgCall.mockResolvedValue(reply(200, { ok: 'yes' }));
    await expect(checkPublishable('f1')).rejects.toBeInstanceOf(ApiUnreachable);
  });
});
