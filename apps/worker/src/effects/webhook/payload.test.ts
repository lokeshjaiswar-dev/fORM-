import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { CompiledForm, FieldCompliance, FormDefinition, ValueFieldType } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { MASK } from '../disclosure.ts';
import { buildWebhookPayload, type WebhookPayloadInput } from './payload.ts';

/*
 * WP-1.18: the body of a webhook request. The purpose filter and the masking are `disclosableFields`' (tested in
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

function build(o: { purposeIds?: string[]; fieldKeys?: string[] | 'all_in_purposes'; keyBy?: 'key' | 'id'; answers?: Record<string, unknown> } = {}) {
  const input: WebhookPayloadInput = {
    eventId: 'event-1',
    event: 'submission.created',
    createdAt: EVENT_AT,
    formId: 'form-1',
    submission: { id: 'sub-1', receivedAt: RECEIVED_AT, answers: o.answers ?? answers },
    definition,
    compiled,
    webhook: { purposeIds: o.purposeIds ?? [RESPOND], fieldKeys: o.fieldKeys ?? 'all_in_purposes', keyBy: o.keyBy ?? 'key' },
  };
  return buildWebhookPayload(input);
}

describe('buildWebhookPayload', () => {
  it('has the shape of the published body: id, event, createdAt, form, submission with answers', () => {
    const { payload } = build();
    expect(payload).toMatchObject({
      id: 'event-1',
      event: 'submission.created',
      createdAt: '2026-11-16T08:00:00.000Z',
      form: { id: 'form-1' },
      submission: { id: 'sub-1', submittedAt: '2026-11-16T07:59:58.000Z' },
    });
    expect(Object.keys(payload)).toEqual(['id', 'event', 'createdAt', 'form', 'submission']);
    expect(Object.keys(payload.submission)).toEqual(['id', 'submittedAt', 'answers']);
  });

  it('leaves a field out of the webhook’s purposes out altogether, even when it is answered', () => {
    const { payload } = build();
    expect(payload.submission.answers).not.toHaveProperty('promo_email');
    expect(JSON.stringify(payload)).not.toContain('marketing.example');
    // Declared for marketing as well, the same webhook receives it.
    expect(build({ purposeIds: [RESPOND, MARKETING] }).payload.submission.answers['promo_email']).toBe('asha@marketing.example');
  });

  it('puts MASK for a masked field, leaves an omitted one out, and never lets the value into the body', () => {
    const { payload } = build();
    expect(payload.submission.answers['pan']).toBe(MASK);
    expect(payload.submission.answers).not.toHaveProperty('ssn');
    const text = JSON.stringify(payload);
    expect(text).not.toContain('ABCDE1234F');
    expect(text).not.toContain('123-45-6789');
  });

  it('sends the typed value of a plain field, a field with no classification and no purposes, and null for an allowed field left blank', () => {
    const { payload } = build();
    expect(payload.submission.answers['full_name']).toBe('Asha');
    expect(payload.submission.answers['note']).toBe('plain');
    expect(payload.submission.answers['nickname']).toBeNull();
  });

  it('narrows to the listed keys with fieldKeys, and never widens: a key outside the purposes stays absent', () => {
    expect(Object.keys(build({ fieldKeys: ['full_name', 'pan'] }).payload.submission.answers)).toEqual(['full_name', 'pan']);
    const wide = build({ fieldKeys: ['full_name', 'promo_email', 'ssn', 'no_such_key'] });
    expect(Object.keys(wide.payload.submission.answers)).toEqual(['full_name']);
    expect(build({ fieldKeys: [] }).payload.submission.answers).toEqual({});
  });

  it('names the answers by block id with keyBy "id", and by field key with keyBy "key"', () => {
    const byId = build({ keyBy: 'id' }).payload.submission.answers;
    expect(byId['blk_name']).toBe('Asha');
    expect(byId['blk_pan']).toBe(MASK);
    expect(byId).not.toHaveProperty('full_name');
    expect(build({ keyBy: 'key' }).payload.submission.answers).not.toHaveProperty('blk_name');
  });

  it('keeps the document order of the form, so the same response always makes the same bytes', () => {
    const keys = Object.keys(build().payload.submission.answers);
    expect(keys.slice(0, 3)).toEqual(['full_name', 'pan', 'note']);
    expect(JSON.stringify(build().payload)).toBe(JSON.stringify(build().payload));
  });

  it('strips what the server keeps for itself: the proof that an email was confirmed by a code', () => {
    const value = build().payload.submission.answers['contact'];
    expect(value).toEqual({ address: 'asha@example.com' });
    expect(JSON.stringify(build().payload)).not.toContain('proof-token');
  });

  it('sends a file as metadata only: no URL, no path, nothing beyond the listed properties', () => {
    const files = build().payload.submission.answers['documents'] as Array<Record<string, unknown>>;
    expect(files).toEqual([{ fileId: 'file_1', name: 'id-card.pdf', sizeBytes: 2048, mime: 'application/pdf', sha256: 'a'.repeat(64), scan: 'clean' }]);
    const text = JSON.stringify(build().payload);
    expect(text).not.toContain('files.example.test');
    expect(text).not.toContain('private/key');
  });

  it('sends the rows of a repeating group keyed like the rest, drops a child the form does not have, and masks a group with a protected child', () => {
    const kids = build().payload.submission.answers['children'];
    expect(kids).toEqual({ rows: [{ rowId: 'row_1', values: { child_name: 'Ravi' } }] });
    expect(build({ keyBy: 'id' }).payload.submission.answers['blk_kids']).toEqual({ rows: [{ rowId: 'row_1', values: { blk_kid_name: 'Ravi' } }] });
    const secret = build().payload.submission.answers['secret_children'];
    expect(secret).toBe(MASK);
    expect(JSON.stringify(build().payload)).not.toContain('PQRST6789U');
    expect(JSON.stringify(build().payload)).not.toContain('not on the form');
  });

  it('masks an answer it cannot read (sealed, or of another type than its field) instead of sending its bytes', () => {
    const sealed = { ...answers, blk_name: { type: 'short_text', sealed: { v: 1, ct: 'c2VhbGVk' } }, blk_nick: { type: 'number', value: '5' } };
    const { payload, sentKeys } = build({ answers: sealed });
    expect(payload.submission.answers['full_name']).toBe(MASK);
    expect(payload.submission.answers['nickname']).toBe(MASK);
    expect(JSON.stringify(payload)).not.toContain('c2VhbGVk');
    expect(sentKeys).not.toContain('full_name');
  });

  it('names in sentKeys the keys whose value is in the body: not the masked, not the blank, not the omitted', () => {
    const { sentKeys } = build();
    expect(sentKeys).toEqual(['full_name', 'note', 'contact', 'documents', 'children']);
    expect(sentKeys).not.toContain('pan');
    expect(sentKeys).not.toContain('nickname');
    expect(sentKeys).not.toContain('ssn');
    // The ledger names field keys even when the body names answers by block id.
    expect(build({ keyBy: 'id' }).sentKeys).toEqual(sentKeys);
  });
});
