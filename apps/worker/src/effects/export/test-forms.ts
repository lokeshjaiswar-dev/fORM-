import { compile } from '@form/logic';
import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { CompiledForm, FieldCompliance, FormDefinition, ReviewUnit, ValueFieldType } from '@form/schema';

/*
 * Form fixtures for the export tests (unit and integration): definitions built the way the builder stores them (registry
 * defaults), compiled for real. Not part of the worker's build: nothing in `src` imports this file but the tests.
 */

export const RESPOND = 'respond';
export const MARKETING = 'marketing';

export const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] });

export interface FieldSpec {
  id: string;
  type?: ValueFieldType;
  label?: string;
  compliance?: Partial<Omit<FieldCompliance, 'purposeIds'>> & { purposeIds?: string[] };
  config?: Record<string, unknown>;
}

export function field(spec: FieldSpec) {
  const type = spec.type ?? 'short_text';
  const defaults = DEFAULT_COMPLIANCE[type];
  return {
    id: spec.id,
    type,
    key: spec.id,
    label: doc(spec.label ?? `Label of ${spec.id}`),
    required: false,
    compliance: { ...defaults, purposeIds: defaults.classification === 'none' ? [] : [RESPOND], ...spec.compliance } as FieldCompliance,
    config: { ...REGISTRY[type].defaultConfig('en-IN' as never), ...spec.config },
  };
}

/** A personal field tied to `respond`, exported as is unless the spec says otherwise. */
export const personal = (id: string, compliance: FieldSpec['compliance'] = {}, extra: Partial<FieldSpec> = {}) =>
  field({ id, compliance: { classification: 'personal', purposeIds: [RESPOND], inNotifications: 'include', inExports: 'include', ...compliance }, ...extra });

/** A sensitive field: `mask` in exports unless the spec says `omit`. */
export const sensitive = (id: string, inExports: 'mask' | 'omit' = 'mask') =>
  personal(id, { classification: 'sensitive', encrypt: true, inNotifications: 'mask', inExports });

export interface DefinitionOptions {
  /** Pages and the block ids on each; by default one page with every block. */
  pages?: ReadonlyArray<{ id: string; children: readonly string[] }>;
  review?: ReviewUnit[];
}

/** A definition that `compile` accepts. */
export function definitionOf(blocks: ReturnType<typeof field>[], o: DefinitionOptions = {}): FormDefinition {
  const purpose = (id: string) => ({
    id,
    name: id,
    description: doc(id),
    lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: 'The respondent sent it' },
    retention: { kind: 'org_default' },
  });
  const pages = o.pages ?? [{ id: 'page_1', children: blocks.map((b) => b.id) }];
  return {
    schemaVersion: 2,
    revision: 0,
    formId: 'form_1',
    title: 'Export fixture',
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    pages: pages.map((p) => ({ id: p.id, children: [...p.children] })),
    endings: [{ id: 'end_1', kind: 'message', name: 'Thanks', content: { type: 'doc', content: [] }, actions: [] }],
    defaultEndingId: 'end_1',
    logic: { rules: [], ruleGroups: [], variables: [] },
    privacy: {
      fiduciary: {
        legalName: ['Acme'],
        contactEmail: ['privacy@acme.example'],
        privacyContact: { name: ['Priya'], email: ['privacy@acme.example'] },
        rightsUrl: ['https://acme.example/rights'],
        boardComplaintInfo: ['You may complain to the Data Protection Board of India.'],
      },
      purposes: [purpose(RESPOND), purpose(MARKETING)],
      children: { mode: 'not_applicable' },
      encryption: { mode: 'server' },
      dropAnswersWithoutConsent: true,
      networkSignals: { ipHash: true, userAgentHash: true, ttlDays: 30 },
    },
    theme: {
      layout: 'classic',
      tokens: { colors: {}, typography: { body: 'inter', baseSizePx: 16 }, radius: 'md', density: 'comfortable', formWidth: 'normal', labelAlign: 'top', inputStyle: 'outlined', progress: 'bar' },
    },
    behavior: {
      submit: { label: 'Submit', align: 'left' },
      navigation: { allowBack: true, showPageTitles: false },
      saveAndResume: { enabled: false, showButton: false, delivery: [], expiryDays: 30 },
      localAutosave: { enabled: false, allowWithSensitive: false },
      timeZone: 'Asia/Kolkata',
      spam: { honeypot: true, minFillSeconds: 0, captcha: 'off' },
      urlPrefill: false,
      showBranding: true,
      a11y: { announceErrors: 'polite', focusFirstError: true },
      successAnimation: false,
    },
    i18n: { defaultLocale: 'en-IN', locales: [{ locale: 'en-IN', direction: 'ltr' }], detect: ['url_param'], urlParam: 'lang', switcher: 'none', messages: {}, systemMessages: {}, reviewedConsentLocales: ['en-IN'] },
    ...(o.review ? { review: { units: o.review } } : {}),
  } as unknown as FormDefinition;
}

export function compiledOf(definition: FormDefinition): CompiledForm {
  const result = compile(definition, REGISTRY);
  if (!result.ok) throw new Error(`fixture does not compile: ${result.issues.map((i) => `${i.code} ${i.path} ${i.message}`).join('; ')}`);
  return result.compiled;
}

/** Stored answers from `[type, value]` pairs by block id. */
export const answered = (byBlock: Record<string, [type: string, value: unknown]>): Record<string, { type: string; value: unknown }> =>
  Object.fromEntries(Object.entries(byBlock).map(([id, [type, value]]) => [id, { type, value }]));
