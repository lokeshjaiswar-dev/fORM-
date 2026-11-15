import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import {
  WEBHOOK_EVENTS,
  WebhookConflict,
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  replayDelivery,
  rotateWebhookSecret,
  saveWebhook,
  type WebhookInput,
} from '@/persistence/webhooksApi';

const HOOK = {
  id: '01970000-0000-7000-8000-0000000000a1',
  formId: '01970000-0000-7000-8000-00000000f001',
  url: 'https://hooks.example.com/form',
  enabled: true,
  events: ['submission.created'],
  keyBy: 'key',
  fieldKeys: 'all_in_purposes',
  purposeIds: ['purpose_ops'],
  files: 'none',
  secretHint: 'a1b2',
  secretRotatedAt: null,
  consecutiveFailures: 0,
  disabledReason: null,
  rev: 3,
  createdAt: '2026-11-10T08:00:00.000Z',
  updatedAt: '2026-11-10T08:00:00.000Z',
};

const DELIVERY = {
  id: '01970000-0000-7000-8000-0000000000d1',
  webhookId: HOOK.id,
  event: 'submission.created',
  submissionId: null,
  status: 'succeeded',
  attempt: 1,
  httpStatus: 200,
  durationMs: 40,
  responseSnippet: null,
  replayOf: null,
  nextAttemptAt: null,
  createdAt: '2026-11-15T10:00:00.000Z',
};

const INPUT: WebhookInput = {
  url: HOOK.url,
  enabled: true,
  events: ['submission.created'],
  keyBy: 'key',
  fieldKeys: 'all_in_purposes',
  purposeIds: ['purpose_ops'],
  files: 'none',
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => json(status, { type: 'about:blank', title: code, status, code, ...extra });

/** Stubs `fetch` to answer `answer`, and returns what the calls were. */
function stubFetch(answer: Response) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      return Promise.resolve(answer.clone());
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('webhooksApi', () => {
  it('offers the events the schema twin has', () => {
    expect(WEBHOOK_EVENTS).toEqual(['submission.created', 'submission.updated', 'submission.deleted', 'payment.succeeded', 'consent.withdrawn']);
  });

  it('lists a form’s webhooks in the named org, with the form id as one path segment', async () => {
    const calls = stubFetch(json(200, { items: [HOOK] }));
    await expect(listWebhooks('o1', 'a/b')).resolves.toEqual([HOOK]);
    expect(calls[0]).toMatchObject({ url: '/v1/forms/a%2Fb/webhooks', method: 'GET', headers: { 'x-fr-org': 'o1' } });
  });

  it('hands the secret of a created webhook back beside it, not inside it', async () => {
    const calls = stubFetch(json(201, { ...HOOK, secret: 'whsec_abc' }));
    const created = await createWebhook('o1', HOOK.formId, INPUT);
    expect(created.secret).toBe('whsec_abc');
    expect(created.webhook).toEqual(HOOK);
    expect(JSON.stringify(created.webhook)).not.toContain('whsec_');
    expect(calls[0]).toMatchObject({ url: `/v1/forms/${HOOK.formId}/webhooks`, method: 'POST', headers: { 'x-fr-org': 'o1', 'x-fr-client': 'builder' }, body: INPUT });
  });

  it('saves with If-Match = the revision that was read, and a stale revision is a WebhookConflict', async () => {
    const calls = stubFetch(json(200, { ...HOOK, rev: 4 }));
    await expect(saveWebhook('o1', HOOK.formId, HOOK.id, INPUT, 3)).resolves.toMatchObject({ rev: 4 });
    expect(calls[0]).toMatchObject({ url: `/v1/forms/${HOOK.formId}/webhooks/${HOOK.id}`, method: 'PUT', headers: { 'if-match': '"3"' }, body: INPUT });

    stubFetch(problem(409, 'WEBHOOK_REV_CONFLICT', { detail: 'The webhook changed since you read it.' }));
    await expect(saveWebhook('o1', HOOK.formId, HOOK.id, INPUT, 3)).rejects.toBeInstanceOf(WebhookConflict);
  });

  it('throws the API’s refusals as ApiProblems the editor reads by code', async () => {
    stubFetch(problem(422, 'EGRESS_DENIED', { detail: 'Use an https address.' }));
    const egress = await createWebhook('o1', HOOK.formId, INPUT).catch((err: unknown) => err);
    expect(egress).toBeInstanceOf(ApiProblem);
    expect(egress).toMatchObject({ status: 422, code: 'EGRESS_DENIED', message: 'Use an https address.' });

    stubFetch(problem(403, 'FORBIDDEN', { detail: 'Requires data.route.' }));
    await expect(listWebhooks('o1', HOOK.formId)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('deletes with a 204 and replaces a secret, answering the new one', async () => {
    let calls = stubFetch(new Response(null, { status: 204 }));
    await expect(deleteWebhook('o1', HOOK.formId, HOOK.id)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: `/v1/forms/${HOOK.formId}/webhooks/${HOOK.id}`, method: 'DELETE' });

    calls = stubFetch(json(200, { secret: 'whsec_new', secretHint: '_new', secretRotatedAt: '2026-11-15T09:00:00.000Z' }));
    await expect(rotateWebhookSecret('o1', HOOK.formId, HOOK.id)).resolves.toEqual({ secret: 'whsec_new', secretHint: '_new', secretRotatedAt: '2026-11-15T09:00:00.000Z' });
    expect(calls[0]).toMatchObject({ url: `/v1/forms/${HOOK.formId}/webhooks/${HOOK.id}/rotate-secret`, method: 'POST' });

    stubFetch(problem(404, 'NOT_FOUND'));
    await expect(deleteWebhook('o1', HOOK.formId, HOOK.id)).rejects.toMatchObject({ status: 404 });
  });

  it('pages the delivery log with the status and the cursor the caller gives, and nothing else', async () => {
    const calls = stubFetch(json(200, { items: [DELIVERY], nextCursor: 'abc' }));
    await expect(listDeliveries('o1', HOOK.formId, HOOK.id)).resolves.toEqual({ items: [DELIVERY], nextCursor: 'abc' });
    await listDeliveries('o1', HOOK.formId, HOOK.id, { limit: 20, status: 'failed', cursor: 'a b' });
    expect(calls[0]?.url).toBe(`/v1/forms/${HOOK.formId}/webhooks/${HOOK.id}/deliveries`);
    expect(calls[1]?.url).toBe(`/v1/forms/${HOOK.formId}/webhooks/${HOOK.id}/deliveries?limit=20&status=failed&cursor=a+b`);
  });

  it('replays one delivery of one webhook and answers the new delivery', async () => {
    const again = { ...DELIVERY, id: '01970000-0000-7000-8000-0000000000d2', status: 'pending', replayOf: DELIVERY.id };
    const calls = stubFetch(json(201, again));
    await expect(replayDelivery('o1', HOOK.formId, HOOK.id, DELIVERY.id)).resolves.toEqual(again);
    expect(calls[0]).toMatchObject({ url: `/v1/forms/${HOOK.formId}/webhooks/${HOOK.id}/deliveries/${DELIVERY.id}/replay`, method: 'POST', headers: { 'x-fr-org': 'o1' } });
  });

  it('treats an answer that is not the shape the API documents as an unreachable API', async () => {
    stubFetch(json(200, { items: [{ ...HOOK, events: 'submission.created' }] }));
    await expect(listWebhooks('o1', HOOK.formId)).rejects.toBeInstanceOf(ApiUnreachable);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network down'))));
    await expect(listDeliveries('o1', HOOK.formId, HOOK.id)).rejects.toBeInstanceOf(ApiUnreachable);
  });
});
