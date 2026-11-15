import { randomUUID } from 'node:crypto';
import type { Fixture, IsolationCase, IsolationDomain, SeedEnv } from './types.ts';

/**
 * Cases for the webhook routes (WP-1.18): a form's webhooks and their delivery log. Each is an `auth: 'user'` route, so
 * each needs a case here or the suite fails.
 *
 * Org A's webhook, its signing secret and one delivery are made by the seed through the migrator handle (the API in this
 * suite has no key provider or egress guard, which creating a webhook needs), as the rows the worker and the routes make:
 * a `secrets` row of kind `webhook_hmac` and a `webhooks` row on org A's form that names it, and a delivery that names
 * the webhook. The cases aim those ids at org B's owner, who has `data.route`, so a refusal can only be the row not being
 * visible to org B: the form of the path is looked up first, under row-level security, and answers 404, and nothing of
 * org A's is written (the suite's baseline hash of every `org_id` table, `secrets`, `webhooks` and `webhook_deliveries`
 * among them, would change). Every body is valid for its route.
 */

/** A host only org A's webhook has, so the suite's scan for org A's identifiers finds the address if any answer carries it. */
export const WEBHOOK_URL = 'https://hooks.org-a-5c1e.example/ingest';

async function seed(env: SeedEnv, f: Fixture): Promise<Record<string, string>> {
  const secretId = randomUUID();
  const webhookId = randomUUID();
  const deliveryId = randomUUID();
  await env.owner.query(`insert into secrets (id, org_id, kind, enc, meta) values ($1, $2, 'webhook_hmac', $3::jsonb, $4::jsonb)`, [
    secretId,
    f.a.orgId,
    JSON.stringify({ v: 1, alg: 'A256GCM', seeded: 'org-a-webhook-secret' }),
    JSON.stringify({ last4: 'a5c1' }),
  ]);
  await env.owner.query(`insert into webhooks (id, org_id, form_id, url, secret_id, events, purpose_ids) values ($1, $2, $3, $4, $5, $6, $7)`, [
    webhookId,
    f.a.orgId,
    f.a.formId,
    WEBHOOK_URL,
    secretId,
    ['submission.created'],
    ['pur_org_a'],
  ]);
  await env.owner.query(`insert into webhook_deliveries (id, org_id, webhook_id, event, status, http_status) values ($1, $2, $3, 'submission.created', 'failed', 500)`, [
    deliveryId,
    f.a.orgId,
    webhookId,
  ]);
  return { webhookId, webhookSecretId: secretId, webhookDeliveryId: deliveryId, webhookUrl: WEBHOOK_URL };
}

const BODY = { url: 'https://hooks.org-b.example/ingest', events: ['submission.created'], purposeIds: ['pur_1'] };
const base = (f: Fixture) => `/v1/forms/${f.a.formId}/webhooks`;

const cases: IsolationCase[] = [
  {
    route: 'GET /v1/forms/:formId/webhooks',
    call: (f) => ({ url: base(f) }),
    note: 'Org A’s own owner gets 200 for the same request (the suite checks it): the list with the seeded webhook. Org B must not learn that the form or its webhook exists.',
  },
  {
    route: 'POST /v1/forms/:formId/webhooks',
    call: (f) => ({ url: base(f), body: BODY }),
    note: 'A valid body: it would add a webhook (and a signing secret) to org A’s form, so that org A’s answers flowed to org B’s address, if the form were visible. The form is looked up before the purposes, the address or the secret are asked about.',
  },
  {
    route: 'GET /v1/forms/:formId/webhooks/:id',
    call: (f) => ({ url: `${base(f)}/${f.extra.webhookId}` }),
    note: 'Org A’s owner gets 200 for the same request (the suite checks it), with the address and the last four characters of the secret; org B must not learn either.',
  },
  {
    route: 'PUT /v1/forms/:formId/webhooks/:id',
    call: (f) => ({ url: `${base(f)}/${f.extra.webhookId}`, body: BODY, headers: { 'if-match': '1' } }),
    note: 'A valid body with the revision the seeded webhook has: it would re-point org A’s webhook at org B’s address if it were visible; the baseline covers `webhooks`.',
  },
  {
    route: 'DELETE /v1/forms/:formId/webhooks/:id',
    call: (f) => ({ url: `${base(f)}/${f.extra.webhookId}` }),
    note: 'Would delete org A’s webhook, its secret row and its delivery log; the baseline covers all three tables.',
  },
  {
    route: 'POST /v1/forms/:formId/webhooks/:id/rotate-secret',
    call: (f) => ({ url: `${base(f)}/${f.extra.webhookId}/rotate-secret` }),
    note: 'Would replace org A’s signing secret and hand the new one to org B: the baseline covers `secrets`, and the answer must carry no secret.',
  },
  {
    route: 'GET /v1/forms/:formId/webhooks/:id/deliveries',
    call: (f) => ({ url: `${base(f)}/${f.extra.webhookId}/deliveries` }),
    note: 'Org A’s owner gets 200 for the same request (the suite checks it): the one seeded delivery, with the receiver’s answer. Org B must not see it.',
  },
  {
    route: 'POST /v1/forms/:formId/webhooks/:id/deliveries/:deliveryId/replay',
    call: (f) => ({ url: `${base(f)}/${f.extra.webhookId}/deliveries/${f.extra.webhookDeliveryId}/replay` }),
    note: 'Would send org A’s response to org A’s receiver again at org B’s request; the baseline covers `webhook_deliveries`, and no job is queued (this suite’s app has no queue, and the 404 comes first).',
  },
];

export const WEBHOOKS_ISOLATION: IsolationDomain = { cases, seed };
