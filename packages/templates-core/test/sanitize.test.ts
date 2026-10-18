import { validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { FormTemplatePayloadSchema, canonicalJson } from '@form/schema';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { TEMPLATE_FORM_ID, instantiate, sanitizeForTemplate, scanPii, verhoeffValid } from '../src/index.ts';
import { ORG_PROFILE, context, eventPayload, form, id, pan, page, versionOf } from './build.ts';
import { NOT_PII, PII, PII_CORPUS, aadhaar } from './pii-corpus.ts';

const sorted = (hits: Array<{ path: string; kind: string }>) => [...hits].map((h) => `${h.path} ${h.kind}`).sort();
const fullOps = (o: NonNullable<(typeof PII_CORPUS)[number]['ops']>): S.FormOps => ({
  formId: id('form_1'), orgId: id('org_acme'), rev: 1, slug: 'event', previousSlugs: [],
  access: { enabled: true, uniqueSubmission: 'off', embedAllowlist: ['partner.example'], password: { argon2idHash: '$argon2id$x', updatedAt: id('2026-10-01T00:00:00Z') }, screens: o.access.screens },
  notifications: o.notifications, webhooks: [], integrations: [], pdfTemplates: o.pdfTemplates,
  retention: { basis: 'submitted_at', onExpiry: 'delete', files: 'with_submission', draftsDays: 30, trashDays: 30 },
  spam: { quarantineDisposable: true, rateLimitPerIpPerHour: 60 }, workflowIds: [], acceptPreviousVersionsHours: 72,
});

describe('PII sanitiser corpus', () => {
  it('has at least 40 planted cases', () => {
    expect(PII_CORPUS).toHaveLength(42);
    expect(new Set(PII_CORPUS.map((c) => c.name)).size).toBe(42);
  });

  it.each(PII_CORPUS.map((c) => [c.name, c] as const))('catches %s', (_name, c) => {
    const { piiHits, payload } = sanitizeForTemplate(c.def, c.ops ? fullOps(c.ops) : undefined, ORG_PROFILE);
    expect(sorted(piiHits)).toEqual(sorted(c.expected));
    expect(FormTemplatePayloadSchema.safeParse(payload).error).toBeUndefined();
  });

  it('reports nothing for a clean form, and nothing for look-alikes', () => {
    const clean = form([pan()], [page('p1', ['pan'])]);
    expect(sanitizeForTemplate(clean, undefined, ORG_PROFILE).piiHits).toEqual([]);
    for (const text of NOT_PII) expect(scanPii(text), text).toEqual([]);
  });

  it('checks Aadhaar numbers with Verhoeff', () => {
    /* Published Verhoeff vectors, independent of the tables in src/pii.ts and in the corpus generator. */
    expect(verhoeffValid('2363')).toBe(true);
    expect(verhoeffValid('2364')).toBe(false);
    expect(verhoeffValid('12345678902')).toBe(true);
    expect(verhoeffValid('12345678901')).toBe(false);
    expect(verhoeffValid('1428570')).toBe(true);
    expect(verhoeffValid(aadhaar('23456789012'))).toBe(true);
    expect(scanPii(`x ${PII.aadhaar} y`)).toEqual([{ kind: 'aadhaar', start: 2, end: 14 }]);
  });

  it('scans long adversarial strings in linear time', () => {
    const inputs = ['a'.repeat(100_000), '1'.repeat(100_000), `x@${'a-'.repeat(50_000)}`, `x@${'a.'.repeat(50_000)}`, 'a@'.repeat(50_000), `${'ravi@example.com '.repeat(6000)}`];
    const started = performance.now();
    for (const text of inputs) scanPii(text);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(scanPii('ravi@example.com '.repeat(3)).map((m) => m.kind)).toEqual(['email', 'email', 'email']);
  });

  it('finds Indian mobiles with a bare 91 prefix, as in wa.me links', () => {
    expect(scanPii('https://wa.me/919876543210')).toEqual([{ kind: 'phone_in', start: 14, end: 26 }]);
    expect(scanPii('Order 1919876543210')).toEqual([]);
  });

  it('reports each kind once per occurrence, a GSTIN not again as a PAN', () => {
    expect(scanPii(`${PII.gstin} ${PII.pan}`).map((m) => m.kind)).toEqual(['gstin', 'pan']);
    expect(scanPii(`${PII.email} ${PII.phone}`).map((m) => m.kind)).toEqual(['email', 'phone_in']);
  });
});

describe('sanitizeForTemplate', () => {
  const def = instantiate(versionOf(eventPayload()), context()).definition;
  const corpusOps = PII_CORPUS.find((c) => c.name === 'notification literal recipient')?.ops;
  const ops = fullOps({ notifications: corpusOps?.notifications ?? [], pdfTemplates: [], access: { screens: { closed: { content: { type: 'doc', content: [] } } } } });
  const { payload, piiHits, warnings } = sanitizeForTemplate(def, ops, ORG_PROFILE);

  it('produces a form payload its twin accepts, with a placeholder form id and no origin stamps', () => {
    expect(FormTemplatePayloadSchema.safeParse(payload).error).toBeUndefined();
    expect(payload.document.formId).toBe(TEMPLATE_FORM_ID);
    expect(canonicalJson(payload)).not.toContain('"bindingId"');
    expect(validateDefinition(payload.document, 'save', REGISTRY).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('carries no access control, analytics ids, webhooks or integrations', () => {
    const json = canonicalJson(payload);
    for (const secret of ['argon2id', 'partner.example', 'G-TEMPLATE1']) expect(json).not.toContain(secret);
    expect(payload.document.behavior.analytics).toBeUndefined();
  });

  it('turns literal recipients into placeholders and notifications, screens into refs', () => {
    expect(payload.refs?.emails?.[0]).toMatchObject({ kind: 'email', role: 'notification', defaultRecipients: [{ kind: 'role', role: 'form_owner' }] });
    expect(payload.refs?.endings?.[0]).toMatchObject({ kind: 'ending', role: 'closed' });
    expect(piiHits).toEqual([{ path: '/refs/emails/0/defaultRecipients/0', kind: 'email' }]);
  });

  it('generalises org-profile values into org variables and declares the variables it uses', () => {
    expect(payload.document.privacy.fiduciary.legalName).toEqual([{ var: { name: 'org.legal_name' } }]);
    expect(payload.document.privacy.fiduciary.privacyContact).toEqual({ name: [{ var: { name: 'org.privacy_contact.name' } }], email: [{ var: { name: 'org.privacy_contact.email' } }] });
    expect(payload.variables.map((v) => v.name).sort()).toEqual(['org.legal_name', 'org.privacy_contact.email', 'org.privacy_contact.name']);
    expect(payload.variables.every((v) => v.binding === 'live' && v.source === 'org_profile')).toBe(true);
    const para = form([], [page('p1', [])]);
    para.blocks[id<S.BlockId>('p')] = { id: id('p'), type: 'paragraph', config: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Run by Acme Pvt Ltd, write to support@acme.example.', marks: [{ type: 'bold' }] }] }] } } };
    const out = sanitizeForTemplate(para, undefined, ORG_PROFILE);
    const block = out.payload.document.blocks[id<S.BlockId>('p')];
    expect(block?.type === 'paragraph' && block.config.content.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Run by ', marks: [{ type: 'bold' }] }, { type: 'var', attrs: { name: 'org.legal_name' } },
        { type: 'text', text: ', write to ', marks: [{ type: 'bold' }] }, { type: 'var', attrs: { name: 'org.support_email' } }, { type: 'text', text: '.', marks: [{ type: 'bold' }] },
      ],
    });
    expect(out.piiHits).toEqual([]);
  });

  it('computes the data inventory, required features and estimated time', () => {
    expect(payload.dataInventory.map((d) => [d.purposeName, d.classification, d.encrypted])).toEqual([['Respond to this form', 'personal', false], ['Verify identity', 'sensitive', true]]);
    expect(payload.dataInventory[0]?.suggestedRetentionDays).toBe(365);
    expect(payload.requiredFeatures).toEqual(['field:date', 'field:email', 'field:heading', 'field:hidden', 'field:long_text', 'field:paragraph', 'field:phone', 'field:section', 'field:short_text', 'field:single_choice']);
    expect(payload.estimatedMinutes).toBe(2);
    expect(warnings.map((w) => w.code)).toEqual(['sensitive_fields']);
  });

  it('round-trips: the payload instantiates again into a valid draft', () => {
    const again = instantiate(versionOf(payload), context({ variables: {} }));
    expect(validateDefinition(again.definition, 'save', REGISTRY).filter((i) => i.severity === 'error')).toEqual([]);
    expect(again.ops.notifications).toHaveLength(1);
  });
});
