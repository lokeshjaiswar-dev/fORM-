import { compile } from '@form/logic';
import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { CompiledForm, EmailDoc, FieldCompliance, FormDefinition, NotificationConfig, PipeAttrs, PlainTemplate, ValueFieldType } from '@form/schema';

/*
 * Fixtures for the notification tests (WP-1.16): a form definition built the way the builder stores one (registry defaults,
 * compiled with the real `compile`, so taint is real), and small builders for an EmailDoc and a NotificationConfig. Shared by
 * `render.test.ts`, `recipients.test.ts` and `notifications.int.test.ts`.
 */

export const RESPOND = 'respond';
export const MARKETING = 'marketing';

export const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] });

export interface Spec {
  id: string;
  type?: ValueFieldType;
  label?: string;
  /** Purpose ids are plain strings here; the definition is cast to the contract type once, in `definitionOf`. */
  compliance?: Partial<Omit<FieldCompliance, 'purposeIds'>> & { purposeIds?: string[] };
  config?: Record<string, unknown>;
}

export function field(spec: Spec) {
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

/** A personal field of the `respond` purpose that notifications include unless told otherwise. */
export const personal = (id: string, compliance: Spec['compliance'] = {}, extra: Partial<Spec> = {}) =>
  field({ id, compliance: { classification: 'personal', purposeIds: [RESPOND], inNotifications: 'include', inExports: 'include', ...compliance }, ...extra });

/** A field whose notification setting is `mask`: sensitive, so it reaches an email as the mask. */
export const maskedField = (id: string, label?: string) =>
  personal(id, { classification: 'sensitive', encrypt: true, inNotifications: 'mask', inExports: 'mask' }, label === undefined ? {} : { label });

/** A field whose notification setting is `omit`: it is in no email. */
export const omittedField = (id: string, label?: string) =>
  personal(id, { classification: 'sensitive', encrypt: true, inNotifications: 'omit', inExports: 'omit' }, label === undefined ? {} : { label });

/** A hidden field that captures `source`, so the compiler taints it with the source's classification (`include` on its own). */
export const copyOf = (id: string, source: string) =>
  field({
    id,
    type: 'hidden',
    compliance: { classification: 'none', purposeIds: [], inNotifications: 'include', inExports: 'include' },
    config: { source: { kind: 'expr', expr: { k: 'ref', ref: { kind: 'answer', blockId: source } } } },
  });

/** A definition that `compile` accepts, with `blocks` on one page. */
export function definitionOf(blocks: ReturnType<typeof field>[], title = 'Notification fixture'): FormDefinition {
  const purpose = (id: string) => ({
    id,
    name: id,
    description: doc(id),
    lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: 'The respondent sent it' },
    retention: { kind: 'org_default' },
  });
  return {
    schemaVersion: 2,
    revision: 0,
    formId: 'form_1',
    title,
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    pages: [{ id: 'page_1', children: blocks.map((b) => b.id) }],
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
  } as unknown as FormDefinition;
}

export const compiledOf = (def: FormDefinition): CompiledForm => {
  const result = compile(def, REGISTRY);
  if (!result.ok) throw new Error(`fixture does not compile: ${result.issues.map((i) => `${i.code} ${i.path} ${i.message}`).join('; ')}`);
  return result.compiled;
};

/** Stored answers by block id: `{ name: ['short_text', 'Asha'] }` becomes `{ name: { type: 'short_text', value: 'Asha' } }`. */
export const answered = (byBlock: Record<string, [type: string, value: unknown]>) =>
  Object.fromEntries(Object.entries(byBlock).map(([id, [type, value]]) => [id, { type, value }]));

// ─── EmailDoc and NotificationConfig builders ───────────────────────────────────────────────────────────────

export const text = (t: string) => ({ type: 'text' as const, text: t });
export const pipe = (blockId: string, o: Partial<PipeAttrs> = {}) => ({ type: 'pipe' as const, attrs: { source: { kind: 'answer' as const, blockId }, ...o } as PipeAttrs });
export const para = (...content: Array<ReturnType<typeof text> | ReturnType<typeof pipe>>) => ({ type: 'paragraph' as const, content });
export const table = (o: { include?: 'all' | string[]; hideEmpty?: boolean; maskSensitive?: boolean } = {}) => ({
  type: 'answersTable' as const,
  attrs: { include: o.include ?? 'all', hideEmpty: o.hideEmpty ?? false, maskSensitive: o.maskSensitive ?? true },
});
export const emailDoc = (...content: unknown[]): EmailDoc => ({ type: 'email_doc', content }) as unknown as EmailDoc;
export const subjectOf = (...parts: Array<string | { pipe: PipeAttrs }>): PlainTemplate => parts as PlainTemplate;

export function notificationConfig(o: Partial<NotificationConfig> & { id: string }): NotificationConfig {
  return {
    name: 'Notification',
    kind: 'owner',
    enabled: true,
    trigger: 'submitted',
    to: [],
    purposeIds: [RESPOND],
    subject: ['New response'],
    body: emailDoc(para(text('A response came in.')), table()),
    locale: 'respondent',
    includeWithdrawalLink: false,
    ...o,
  } as unknown as NotificationConfig;
}
