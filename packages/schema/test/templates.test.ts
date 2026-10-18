import { describe, expect, it } from 'vitest';
import * as S from '../src/index.ts';
import { definition, id } from './fixtures.ts';
import { PAYLOADS, emailPayload, endingPayload, formPayload, manifest, themePayload, workflowPayload } from './template-fixtures.ts';

declare global {
  interface ImportMeta { glob<T>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T> }
}

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const wire = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));
const literal = { kind: 'email', address: 'someone@example.com' };
const member = { kind: 'member', userId: 'user_1' };

describe('template kinds', () => {
  it('_kindsOk holds and every kind has exactly one payload twin', () => {
    expect(S._kindsOk).toBe(true);
    const unionKinds = S.TemplateVersionPayloadSchema.options.map((o) => o.shape.kind.value);
    expect([...unionKinds].sort()).toEqual([...S.TEMPLATE_KINDS].sort());
    expect(Object.keys(S.TEMPLATE_PAYLOAD_SCHEMAS).sort()).toEqual([...S.TEMPLATE_KINDS].sort());
    for (const kind of S.TEMPLATE_KINDS) expect(S.TEMPLATE_PAYLOAD_SCHEMAS[kind].shape.kind.value).toBe(kind);
  });

  it.each(S.TEMPLATE_KINDS)('a %s payload parses, round-trips through JSON and keeps its kind', (kind) => {
    const payload = PAYLOADS[kind]();
    const parsed = S.TEMPLATE_PAYLOAD_SCHEMAS[kind].parse(wire(payload));
    expect(parsed).toStrictEqual(wire(payload));
    expect(S.canonicalJson(parsed)).toBe(S.canonicalJson(payload));
    expect(S.TemplateVersionPayloadSchema.parse(wire(payload)).kind).toBe(kind);
  });

  it('a payload of one kind never parses as another', () => {
    for (const kind of S.TEMPLATE_KINDS) {
      for (const other of S.TEMPLATE_KINDS) {
        if (other !== kind) expect(ok(S.TEMPLATE_PAYLOAD_SCHEMAS[other], PAYLOADS[kind]())).toBe(false);
      }
    }
  });
});

describe('template payloads hold placeholders, never literal recipients', () => {
  it('email defaultRecipients and replyTo', () => {
    const email = emailPayload();
    expect(ok(S.EmailTemplatePayloadSchema, email)).toBe(true);
    expect(ok(S.EmailTemplatePayloadSchema, { ...email, defaultRecipients: [literal] })).toBe(false);
    expect(ok(S.EmailTemplatePayloadSchema, { ...email, defaultRecipients: [member] })).toBe(false);
    expect(ok(S.EmailTemplatePayloadSchema, { ...email, replyTo: literal })).toBe(false);
  });

  it('workflow approvers and notify steps', () => {
    const payload = workflowPayload();
    const [approval, notify] = payload.workflow.steps;
    const withSteps = (steps: unknown[]) => ({ ...payload, workflow: { ...payload.workflow, steps } });
    expect(ok(S.WorkflowTemplatePayloadSchema, withSteps([approval, notify]))).toBe(true);
    expect(ok(S.WorkflowTemplatePayloadSchema, withSteps([{ ...approval, approver: literal }, notify]))).toBe(false);
    expect(ok(S.WorkflowTemplatePayloadSchema, withSteps([approval, { ...notify, to: [literal] }]))).toBe(false);
  });

  it('inline refs inside a form payload', () => {
    const form = formPayload();
    const bad = { ...emailPayload(), defaultRecipients: [literal] };
    expect(ok(S.FormTemplatePayloadSchema, { ...form, refs: { emails: [bad] } })).toBe(false);
    expect(ok(S.TemplateVersionPayloadSchema, { ...form, refs: { emails: [bad] } })).toBe(false);
  });
});

describe('template parts', () => {
  it('var nodes name a namespaced variable', () => {
    expect(ok(S.VarNodeSchema, { type: 'var', attrs: { name: 'org.privacy_contact.email' } })).toBe(true);
    expect(ok(S.VarNodeSchema, { type: 'var', attrs: { name: 'custom.event_name', fallback: 'our event' } })).toBe(true);
    expect(ok(S.VarNodeSchema, { type: 'var', attrs: { name: 'secret.api_key' } })).toBe(false);
    expect(ok(S.VarNodeSchema, { type: 'var', attrs: { name: 'org.Legal Name' } })).toBe(false);
    expect(ok(S.PlainTemplateSchema, ['Hi ', { var: { name: 'custom.event_name' } }])).toBe(true);
    expect(ok(S.PlainTemplateSchema, [{ var: { name: 'event_name' } }])).toBe(false);
  });

  it('template variables, locks and refs', () => {
    const lock = themePayload().locks[0];
    expect(ok(S.LockSpecSchema, lock)).toBe(true);
    expect(ok(S.LockSpecSchema, { ...lock, modes: [] })).toBe(false);
    expect(ok(S.LockSpecSchema, { ...lock, target: { kind: 'notification', sourceId: 'n' } })).toBe(false);
    const [first] = formPayload().variables;
    expect(ok(S.TemplateVariableSchema, first)).toBe(true);
    expect(ok(S.TemplateVariableSchema, { ...first, binding: 'sync' })).toBe(false);
    expect(ok(S.TemplateRefSchema, { templateId: 'tpl_1', versionId: 'tplv_1' })).toBe(true);
    expect(ok(S.TemplateRefSchema, { templateId: 'tpl_1' })).toBe(false);
  });

  it('origin stamps on blocks, pages, endings and rules', () => {
    const origin = { bindingId: 'bind_1', sourceId: 'name_1' };
    const doc = definition();
    const page = doc.pages[0];
    const ending = doc.endings[0];
    const rule = doc.logic.rules[0];
    expect(ok(S.PageSchema, { ...page, origin })).toBe(true);
    expect(ok(S.EndingSchema, { ...ending, origin })).toBe(true);
    expect(ok(S.RuleSchema, { ...rule, origin })).toBe(true);
    expect(ok(S.BlockSchema, { ...doc.blocks['name_1' as S.BlockId], origin })).toBe(true);
    expect(ok(S.OriginSchema, { bindingId: 'bind_1', sourceId: '' })).toBe(false);
    expect(ok(S.PageSchema, { ...page, origin: { sourceId: 'p' } })).toBe(false);
  });

  it('fork bindings keep lineage to the upstream version', () => {
    const fork = {
      id: 'fork_1', orgId: 'org_1', templateId: 'tpl_fork', upstreamTemplateId: 'tpl_sys', upstreamVersionId: 'tplv_sys_3',
      idMap: { name_1: 'name_9' }, updateState: 'dismissed@4',
    };
    expect(ok(S.TemplateForkBindingSchema, fork)).toBe(true);
    expect(ok(S.TemplateForkBindingSchema, { ...fork, updateState: 'dismissed@' })).toBe(false);
    expect(ok(S.TemplateForkBindingSchema, { ...fork, idMap: JSON.parse('{"__proto__":"x"}') })).toBe(false);
  });

  it('formpack manifests, signatures and attestations', () => {
    expect(ok(S.FormpackManifestSchema, manifest())).toBe(true);
    const { attestations: _omit, ...withoutAttestations } = manifest();
    expect(ok(S.FormpackManifestSchema, withoutAttestations)).toBe(true);
    expect(ok(S.FormpackManifestSchema, { ...manifest(), formatVersion: 2 })).toBe(false);
    expect(ok(S.FormpackManifestSchema, { ...manifest(), categories: 'categories.json' })).toBe(false);
    expect(ok(S.FormpackManifestSchema, { ...manifest(), categories: { path: 'categories.json' } })).toBe(false);
    expect(ok(S.FormpackManifestSchema, { ...manifest(), attestations: { path: 'attestations.json', sha256: 'A'.repeat(64) } })).toBe(false);
    expect(ok(S.FormpackManifestSchema, { ...manifest(), templates: [{ ...manifest().templates[0], kind: 'survey' }] })).toBe(false);
    expect(ok(S.FormpackSignatureSchema, { alg: 'ed25519', keyId: 'fORM-release-2026', sig: 'c2ln' })).toBe(true);
    expect(ok(S.FormpackSignatureSchema, { alg: 'es256', keyId: 'azure-kv-1', sig: 'c2ln' })).toBe(true);
    expect(ok(S.FormpackSignatureSchema, { alg: 'rs256', keyId: 'k', sig: 'c2ln' })).toBe(false);
    const attestation = { slug: 'core/consent', version: 2, locale: 'hi-IN', reviewer: 'A. Counsel', reviewedAt: '2026-09-30', scope: 'consent notice hi-IN' };
    expect(ok(S.FormpackAttestationSchema, attestation)).toBe(true);
    expect(ok(S.FormpackAttestationSchema, { ...attestation, reviewedAt: '30/09/2026' })).toBe(false);
  });
});

describe('migrateTemplatePayload', () => {
  const note = (path: string): S.MigrationNote => ({ path, code: 'clamped', detail: 'test' });
  const themeV1 = () => {
    const { tokens, ...rest } = themePayload();
    return { ...rest, schemaVersion: 1, legacyTokens: tokens };
  };
  const themeStep: S.TemplatePayloadMigrationStep = {
    from: 1,
    to: 2,
    kinds: ['theme'],
    migrate: ({ legacyTokens, ...rest }) => ({ payload: { ...rest, tokens: legacyTokens }, notes: [note('/tokens')] }),
  };

  it('passes current payloads through unchanged and never mutates its input', () => {
    for (const kind of S.TEMPLATE_KINDS) {
      const input = wire(PAYLOADS[kind]());
      const before = JSON.stringify(input);
      const result = S.migrateTemplatePayload(input);
      expect(result).toEqual({ ok: true, payload: input, notes: [] });
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(S.TEMPLATE_PAYLOAD_MIGRATIONS).toEqual([]);
  });

  it('runs payload steps in sequence for their kinds', () => {
    const input = themeV1();
    const result = S.migrateTemplatePayload(input, { steps: [themeStep] });
    expect(result).toEqual({ ok: true, payload: wire(themePayload()), notes: [note('/tokens')] });
    expect(input.schemaVersion).toBe(1);
    expect(S.migrateTemplatePayload({ ...(wire(endingPayload()) as object), schemaVersion: 1 }, { steps: [themeStep] })).toEqual({
      ok: false,
      issues: [{ code: 'migration_step_missing', path: '/schemaVersion', message: 'no ending payload step from schemaVersion 1' }],
    });
  });

  it('migrates inline refs as payloads with their own paths and leaves TemplateRefs alone', () => {
    const form = wire(formPayload()) as Record<string, unknown>;
    const refs = { theme: themeV1(), endings: [wire(endingPayload())], emails: [{ templateId: 'tpl_email', versionId: 'tplv_email_1' }] };
    const result = S.migrateTemplatePayload({ ...form, refs }, { steps: [themeStep] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes).toEqual([note('/refs/theme/tokens')]);
    expect(result.payload.kind === 'form' && result.payload.refs?.theme).toEqual(wire(themePayload()));
    expect(result.payload.kind === 'form' && result.payload.refs?.emails).toEqual(refs.emails);
  });

  it('sends a form document that is not current through the form migrate() hook', () => {
    const v1Document = { title: 'Contact', blocks: [] };
    const form = { ...(wire(formPayload()) as object), document: v1Document };
    expect(S.migrateTemplatePayload(form)).toEqual({
      ok: false,
      issues: [{ code: 'document_migration_unavailable', path: '/document', message: 'the document is not at the current schemaVersion and no form migrate() was given' }],
    });
    const seen: unknown[] = [];
    const migrateDocument = (doc: unknown) => {
      seen.push(doc);
      return { definition: definition(), notes: [note('/blocks/0')] };
    };
    const result = S.migrateTemplatePayload(form, { migrateDocument });
    expect(seen).toEqual([v1Document]);
    expect(result).toMatchObject({ ok: true, payload: { kind: 'form', document: wire(definition()) }, notes: [note('/document/blocks/0')] });
  });

  it('reports what it cannot migrate', () => {
    const code = (input: unknown, ctx?: S.TemplateMigrationContext) => {
      const result = S.migrateTemplatePayload(input, ctx);
      return result.ok ? null : result.issues.map((i) => `${i.code}@${i.path}`);
    };
    expect(code('form')).toEqual(['payload_not_object@']);
    expect(code([themePayload()])).toEqual(['payload_not_object@']);
    expect(code({ ...themePayload(), kind: 'survey' })).toEqual(['unknown_kind@/kind']);
    const { schemaVersion: _drop, ...noVersion } = themePayload();
    expect(code(noVersion)).toEqual(['schema_version_invalid@/schemaVersion']);
    expect(code({ ...themePayload(), schemaVersion: 1.5 })).toEqual(['schema_version_invalid@/schemaVersion']);
    expect(code({ ...themePayload(), schemaVersion: S.SCHEMA_VERSION + 1 })).toEqual(['schema_version_newer@/schemaVersion']);
    const throwing: S.TemplatePayloadMigrationStep = { ...themeStep, migrate: () => { throw new Error('boom'); } };
    expect(code(themeV1(), { steps: [throwing] })).toEqual(['migration_failed@']);
    expect(code({ ...emailPayload(), defaultRecipients: [literal] })).toEqual(['invalid_payload@/defaultRecipients/0/kind']);
    expect(code({ ...formPayload(), refs: { endings: [{ ...endingPayload(), schemaVersion: 9 }] } })).toEqual(['schema_version_newer@/refs/endings/0/schemaVersion']);
  });
});

/* Test harness for the system templates: wrap, migrate, parse, then the structural invariants and declared variables. */

const BUILT_IN_NAMESPACES = ['org.', 'brand.', 'form.'];

function varNames(root: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (typeof node !== 'object' || node === null) continue;
    const rec = node as Record<string, unknown>;
    const attrs = rec['type'] === 'var' ? rec['attrs'] : rec['var'];
    if (typeof attrs === 'object' && attrs !== null && typeof (attrs as { name?: unknown }).name === 'string') out.push((attrs as { name: string }).name);
    stack.push(...Object.values(rec));
  }
  return out;
}

function formTemplateFromV1(v1: unknown): unknown {
  return {
    kind: 'form',
    schemaVersion: S.SCHEMA_VERSION,
    document: v1,
    variables: [],
    locks: [],
    requiredFeatures: [],
    i18n: { defaultLocale: 'en-IN', locales: [{ locale: 'en-IN', direction: 'ltr' }], messages: {} },
    dataInventory: [],
    estimatedMinutes: 1,
  };
}

function expectValidFormTemplate(input: unknown, ctx: S.TemplateMigrationContext = {}): S.FormTemplatePayload {
  const result = S.migrateTemplatePayload(input, ctx);
  expect(result.ok ? [] : result.issues).toEqual([]);
  if (!result.ok || result.payload.kind !== 'form') throw new Error('not a form template');
  const { payload } = result;
  expect(S.validateStructure(payload.document, { mode: 'save' }).filter((i) => i.severity === 'error')).toEqual([]);
  const declared = new Set(payload.variables.map((v) => v.name));
  const undeclared = varNames(payload).filter((n) => !declared.has(n as S.TemplateVariableName) && !BUILT_IN_NAMESPACES.some((ns) => n.startsWith(ns)));
  expect(undeclared).toEqual([]);
  return payload;
}

describe('system template harness', () => {
  it('accepts a current form template', () => {
    expect(expectValidFormTemplate(wire(formPayload())).document.title).toBe('Event registration');
  });

  it('runs a v1 document through the injected form migrate()', () => {
    const payload = expectValidFormTemplate(formTemplateFromV1({ title: 'Contact Us', blocks: [] }), {
      migrateDocument: () => ({ definition: { ...definition(), formId: id<S.FormId>('form_contact') }, notes: [] }),
    });
    expect(payload.document.formId).toBe('form_contact');
  });

  it('rejects an undeclared custom variable', () => {
    const form = formPayload();
    const input = { ...form, variables: form.variables.filter((v) => v.name !== 'custom.event_name') };
    expect(() => expectValidFormTemplate(wire(input))).toThrow();
  });

  /*
   * WP-0.05 adds the v1 → v2 form migrate() and the v1 fixture corpus (test/fixtures/v1/templates/*.json, the five
   * apps/builder/src/data/templates.ts forms). Bind migrate() to its MigrationContext as `migrateDocument` here and drop the skip.
   */
  const migrateDocument: S.TemplateMigrationContext['migrateDocument'] = undefined as S.TemplateMigrationContext['migrateDocument'];
  it.skip('the 5 current templates validate (skipped until WP-0.05 lands v1 → v2 migrate() and the v1 template fixtures)', () => {
    const v1Templates = import.meta.glob<unknown>('./fixtures/v1/templates/*.json', { eager: true, import: 'default' });
    expect(Object.keys(v1Templates)).toHaveLength(5);
    for (const v1 of Object.values(v1Templates)) expectValidFormTemplate(formTemplateFromV1(v1), migrateDocument ? { migrateDocument } : {});
  });
});
