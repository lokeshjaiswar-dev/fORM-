import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { CompiledForm, FieldCompliance, FormDefinition, ValueFieldType } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { MASK } from '../disclosure.ts';
import { createHmac } from 'node:crypto';
import { buildWebhookPayload, type WebhookPayloadInput } from './payload.ts';
import { MAX_CUSTOM_BODY_BYTES, BodyRefused, renderWebhookBody } from './body.ts';
import { signWebhook } from './sign.ts';
import { verifyWebhook } from './verify-recipe.ts';

/*
 * Payload mapping and XML bodies on top of the standard payload (INT-01 follow-up). The standard payload is the disclosure-filtered one (payload.test.ts);
 * these tests prove the mapping only reshapes it. Fixture copied from payload.test.ts.
 *
 * Original note: the body of a webhook request. The purpose filter and the masking are `disclosableFields`' (tested in
 * disclosure.test.ts); these tests prove the webhook uses it and shapes what comes back: the names of the answers, typed
 * values, files as metadata without a URL, and nothing the server keeps for itself.
 */

const RESPOND = 'respond';
const MARKETING = 'marketing';
const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] });

interface Spec {
  id: string;
  /** The machine name a webhook uses with `keyBy: 'key'`; it differs from the block id on purpose. */
  key: string;
  type?: ValueFieldType;
  compliance?: Partial<Omit<FieldCompliance, 'purposeIds'>> & { purposeIds?: string[] };
  config?: Record<string, unknown>;
}

function field(spec: Spec) {
  const type = spec.type ?? 'short_text';
  const defaults = DEFAULT_COMPLIANCE[type];
  return {
    id: spec.id,
    type,
    key: spec.key,
    label: doc(`Label of ${spec.key}`),
    required: false,
    compliance: { ...defaults, purposeIds: defaults.classification === 'none' ? [] : [RESPOND], ...spec.compliance } as FieldCompliance,
    config: { ...REGISTRY[type].defaultConfig('en-IN' as never), ...spec.config },
  };
}

const personal = (spec: Spec) => field({ ...spec, compliance: { classification: 'personal', purposeIds: [RESPOND], inNotifications: 'include', inExports: 'include', ...spec.compliance } });

const blocks = [
  personal({ id: 'blk_name', key: 'full_name' }),
  personal({ id: 'blk_pan', key: 'pan', compliance: { classification: 'sensitive', inNotifications: 'mask' } }),
  personal({ id: 'blk_ssn', key: 'ssn', compliance: { classification: 'sensitive', inNotifications: 'omit' } }),
  personal({ id: 'blk_promo', key: 'promo_email', compliance: { purposeIds: [MARKETING] } }),
  field({ id: 'blk_note', key: 'note' }),
  personal({ id: 'blk_nick', key: 'nickname' }),
  personal({ id: 'blk_mail', key: 'contact', type: 'email' }),
  personal({ id: 'blk_docs', key: 'documents', type: 'file_upload' }),
  personal({ id: 'blk_kids', key: 'children', type: 'repeating_group', config: { children: ['blk_kid_name'] } }),
  personal({ id: 'blk_kid_name', key: 'child_name' }),
  personal({ id: 'blk_secret_kids', key: 'secret_children', type: 'repeating_group', config: { children: ['blk_kid_pan'] } }),
  personal({ id: 'blk_kid_pan', key: 'child_pan', compliance: { classification: 'sensitive', inNotifications: 'mask' } }),
];

const definition = {
  schemaVersion: 2,
  formId: 'form_1',
  blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
  pages: [{ id: 'page_1', children: blocks.filter((b) => !['blk_kid_name', 'blk_kid_pan'].includes(b.id)).map((b) => b.id) }],
  privacy: { purposes: [{ id: RESPOND }, { id: MARKETING }] },
} as unknown as FormDefinition;

const compiled = { taint: {} } as unknown as CompiledForm;

const FILE = { fileId: 'file_1', name: 'id-card.pdf', sizeBytes: 2048, mime: 'application/pdf', sha256: 'a'.repeat(64), scan: 'clean', url: 'https://files.example.test/signed?x=1', path: 'private/key' };

const answers = {
  blk_name: { type: 'short_text', value: 'Asha' },
  blk_pan: { type: 'short_text', value: 'ABCDE1234F' },
  blk_ssn: { type: 'short_text', value: '123-45-6789' },
  blk_promo: { type: 'short_text', value: 'asha@marketing.example' },
  blk_note: { type: 'short_text', value: 'plain' },
  blk_mail: { type: 'email', value: { address: 'asha@example.com', otpProof: 'proof-token' } },
  blk_docs: { type: 'file_upload', value: [FILE] },
  blk_kids: { type: 'repeating_group', value: { rows: [{ rowId: 'row_1', values: { blk_kid_name: { type: 'short_text', value: 'Ravi' }, blk_stray: { type: 'short_text', value: 'not on the form' } } }] } },
  blk_secret_kids: { type: 'repeating_group', value: { rows: [{ rowId: 'row_1', values: { blk_kid_pan: { type: 'short_text', value: 'PQRST6789U' } } }] } },
};

const EVENT_AT = new Date('2026-11-16T08:00:00.000Z');
const RECEIVED_AT = new Date('2026-11-16T07:59:58.000Z');


function built(o: { purposeIds?: string[]; keyBy?: 'key' | 'id' } = {}) {
  const input: WebhookPayloadInput = {
    eventId: 'event-1',
    event: 'submission.created',
    createdAt: EVENT_AT,
    formId: 'form-1',
    submission: { id: 'sub-1', receivedAt: RECEIVED_AT, answers },
    definition,
    compiled,
    webhook: { purposeIds: o.purposeIds ?? [RESPOND], fieldKeys: 'all_in_purposes', keyBy: o.keyBy ?? 'key' },
  };
  return buildWebhookPayload(input);
}

const ans = (path: string, key: string) => ({ path, source: { kind: 'answer' as const, key } });
const JSON_CT = 'application/json';

describe('renderWebhookBody: default', () => {
  it('sends the standard payload unchanged when there is no mapping (json)', () => {
    const b = built();
    const r = renderWebhookBody(b, { bodyFormat: 'json', payloadMapping: null });
    expect(r.body).toBe(JSON.stringify(b.payload));
    expect(r.contentType).toBe(JSON_CT);
    expect(r.sentKeys).toEqual(b.sentKeys);
  });

  it('renders the standard payload as XML with no mapping', () => {
    const r = renderWebhookBody(built(), { bodyFormat: 'xml', payloadMapping: null });
    expect(r.contentType).toBe('application/xml; charset=utf-8');
    expect(r.body.startsWith('<?xml version="1.0" encoding="UTF-8"?><webhook><id>event-1</id>')).toBe(true);
    expect(r.body).toContain('<full_name>Asha</full_name>');
  });
});

describe('renderWebhookBody: mapping', () => {
  it('maps answers and meta to dotted paths', () => {
    const r = renderWebhookBody(built(), {
      bodyFormat: 'json',
      payloadMapping: { entries: [ans('customer.name', 'full_name'), ans('customer.mail', 'contact'), { path: 'ref', source: { kind: 'meta', name: 'submissionId' } }] },
    });
    expect(JSON.parse(r.body)).toEqual({ customer: { name: 'Asha', mail: { address: 'asha@example.com' } }, ref: 'sub-1' });
    expect(r.sentKeys).toEqual(['full_name', 'contact']);
  });

  it('spreads the rows of a repeating group over []', () => {
    const r = renderWebhookBody(built(), { bodyFormat: 'json', payloadMapping: { entries: [ans('kids[]', 'children')] } });
    // The group value is one object, so it becomes a one-element array.
    expect(JSON.parse(r.body)).toEqual({ kids: [{ rows: [{ rowId: 'row_1', values: { child_name: 'Ravi' } }] }] });
  });

  it('never bypasses disclosure: out-of-purpose and omitted fields cannot be mapped, masked ones stay masked', () => {
    const r = renderWebhookBody(built(), {
      bodyFormat: 'json',
      payloadMapping: { entries: [ans('a', 'promo_email'), ans('b', 'ssn'), ans('c', 'pan'), ans('d', 'secret_children'), ans('e', 'full_name')] },
    });
    expect(JSON.parse(r.body)).toEqual({ c: MASK, d: MASK, e: 'Asha' });
    for (const secret of ['marketing.example', '123-45-6789', 'ABCDE1234F', 'PQRST6789U']) expect(r.body).not.toContain(secret);
    expect(r.sentKeys).toEqual(['full_name']);
    // Declared for marketing as well, the same mapping now carries it.
    const wide = renderWebhookBody(built({ purposeIds: [RESPOND, MARKETING] }), { bodyFormat: 'json', payloadMapping: { entries: [ans('a', 'promo_email')] } });
    expect(JSON.parse(wide.body)).toEqual({ a: 'asha@marketing.example' });
  });

  it('masks in XML too and refers to fields by key even with keyBy "id"', () => {
    const r = renderWebhookBody(built({ keyBy: 'id' }), { bodyFormat: 'xml', payloadMapping: { root: 'order', entries: [ans('p', 'pan'), ans('n', 'full_name'), ans('s', 'ssn')] } });
    expect(r.body).toBe(`<?xml version="1.0" encoding="UTF-8"?><order><p>${MASK}</p><n>Asha</n></order>`);
    expect(r.body).not.toContain('ABCDE1234F');
  });

  it('escapes hostile answers in XML so they cannot add elements, entities or a DTD', () => {
    const evil = { ...answers, blk_name: { type: 'short_text', value: '</n><!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]>&y;<injected a="1"/>' } };
    const input = { eventId: 'e', event: 'submission.created', createdAt: EVENT_AT, formId: 'f', submission: { id: 's', receivedAt: RECEIVED_AT, answers: evil }, definition, compiled, webhook: { purposeIds: [RESPOND], fieldKeys: 'all_in_purposes', keyBy: 'key' } } as WebhookPayloadInput;
    const r = renderWebhookBody(buildWebhookPayload(input), { bodyFormat: 'xml', payloadMapping: { entries: [ans('n', 'full_name')] } });
    expect(r.body).not.toContain('<!DOCTYPE');
    expect(r.body).not.toContain('<injected');
    expect(r.body).toContain('&lt;injected a=&quot;1&quot;/&gt;');
  });

  it('refuses an invalid stored mapping instead of sending a guess', () => {
    expect(() => renderWebhookBody(built(), { bodyFormat: 'json', payloadMapping: { entries: [ans('a', 'x'), ans('a.b', 'y')] } })).toThrow(BodyRefused);
    expect(() => renderWebhookBody(built(), { bodyFormat: 'xml', payloadMapping: { root: 'bad root', entries: [] } })).toThrow(BodyRefused);
  });

  it('refuses a custom body over the size cap', () => {
    const big = { ...answers, blk_note: { type: 'short_text', value: 'x'.repeat(MAX_CUSTOM_BODY_BYTES) } };
    const input = { eventId: 'e', event: 'submission.created', createdAt: EVENT_AT, formId: 'f', submission: { id: 's', receivedAt: RECEIVED_AT, answers: big }, definition, compiled, webhook: { purposeIds: [RESPOND], fieldKeys: 'all_in_purposes', keyBy: 'key' } } as WebhookPayloadInput;
    expect(() => renderWebhookBody(buildWebhookPayload(input), { bodyFormat: 'json', payloadMapping: { entries: [ans('n', 'note')] } })).toThrow(/1 MiB/);
  });
});

describe('signing over the rendered bytes', () => {
  const SECRET = 'whsec_test-secret';
  const T = 1_731_744_000;
  it('verifies an XML body (with non-ASCII text) against the published recipe, and any change breaks it', () => {
    const answersU = { ...answers, blk_name: { type: 'short_text', value: 'Asha Ünal ☃ <&>' } };
    const input = { eventId: 'e', event: 'submission.created', createdAt: EVENT_AT, formId: 'f', submission: { id: 's', receivedAt: RECEIVED_AT, answers: answersU }, definition, compiled, webhook: { purposeIds: [RESPOND], fieldKeys: 'all_in_purposes', keyBy: 'key' } } as WebhookPayloadInput;
    const r = renderWebhookBody(buildWebhookPayload(input), { bodyFormat: 'xml', payloadMapping: { entries: [ans('n', 'full_name')] } });
    const header = signWebhook(SECRET, r.body, T);
    expect(verifyWebhook(new TextEncoder().encode(r.body), header, SECRET, T)).toBe(true);
    expect(header).toBe(`t=${T},v1=${createHmac('sha256', SECRET).update(`${T}.`).update(Buffer.from(r.body, 'utf8')).digest('hex')}`);
    expect(verifyWebhook(r.body.replace('Asha', 'Bsha'), header, SECRET, T)).toBe(false);
    expect(r.contentType.startsWith('application/xml')).toBe(true);
  });
});
