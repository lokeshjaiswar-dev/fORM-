import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { FormDefinition, Locale } from '@form/schema';

const para = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
});

/** A v2 definition `FormDefinitionSchema` accepts, for publish integration tests. */
export function publishableDraft(formId: string, title = 'Live form'): FormDefinition {
  return {
    schemaVersion: 2,
    revision: 0,
    formId: formId as FormDefinition['formId'],
    title,
    blocks: {},
    pages: [{ id: 'page_1' as FormDefinition['pages'][0]['id'], children: [] }],
    endings: [
      {
        id: 'end_1' as FormDefinition['defaultEndingId'],
        kind: 'message',
        name: 'Thank you',
        content: para('Thanks'),
        actions: [{ kind: 'fill_again', prefill: 'none' }],
        confetti: false,
      },
    ],
    defaultEndingId: 'end_1' as FormDefinition['defaultEndingId'],
    logic: { rules: [], ruleGroups: [], variables: [] },
    privacy: {
      fiduciary: {
        legalName: [{ var: { name: 'org.legal_name' } }],
        contactEmail: [{ var: { name: 'org.support_email' } }],
        privacyContact: { name: [{ var: { name: 'org.privacy_contact.name' } }], email: [{ var: { name: 'org.privacy_contact.email' } }] },
        rightsUrl: [{ var: { name: 'org.rights_url' } }],
        boardComplaintInfo: [{ var: { name: 'org.board_complaint_info' } }],
      },
      purposes: [
        {
          id: 'pur_1' as FormDefinition['privacy']['purposes'][0]['id'],
          name: 'Respond to this form',
          description: para('Handle this response'),
          lawfulBasis: {
            kind: 'legitimate_use',
            ground: 's7a_voluntarily_provided_for_specified_purpose',
            justification: 'The respondent sent this form',
          },
          retention: { kind: 'org_default' },
        },
      ],
      children: { mode: 'not_applicable' },
      encryption: { mode: 'server' },
      dropAnswersWithoutConsent: true,
      networkSignals: { ipHash: true, userAgentHash: true, ttlDays: 30 },
    },
    theme: {
      layout: 'classic',
      tokens: {
        colors: {},
        typography: { body: 'inter' as FormDefinition['theme']['tokens']['typography']['body'], baseSizePx: 16 },
        radius: 'md',
        density: 'comfortable',
        formWidth: 'normal',
        labelAlign: 'top',
        inputStyle: 'outlined',
        progress: 'none',
      },
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
    i18n: {
      defaultLocale: 'en-IN',
      locales: [{ locale: 'en-IN', direction: 'ltr' }],
      detect: ['url_param'],
      urlParam: 'lang',
      switcher: 'none',
      messages: {},
      systemMessages: {},
      reviewedConsentLocales: [],
    },
  } as unknown as FormDefinition;
}

type FieldType = 'file_upload' | 'signature' | 'short_text' | 'email' | 'number';

/** A value field of a registry type, on its default config (`config` is merged over it), as the builder creates one. */
export function fieldBlock(id: string, type: FieldType, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const defaults = DEFAULT_COMPLIANCE[type];
  return {
    id,
    type,
    key: id,
    label: { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: id }] }] },
    required: false,
    compliance: { ...defaults, purposeIds: defaults.classification === 'none' ? [] : ['pur_1'] },
    config: { ...REGISTRY[type].defaultConfig('en-IN' as Locale), ...config },
    ...extra,
  };
}

type Ending = FormDefinition['endings'][number];

/** `def` with a redirect ending to `url` (a URL template: literal text, and pipes after it) added after its first ending. */
export function withRedirectEnding(def: FormDefinition, url: unknown[], id = 'end_redirect'): FormDefinition {
  const ending = { id, kind: 'redirect', name: 'Go on', url } as unknown as Ending;
  return { ...def, endings: [...def.endings, ending] };
}

/** A rule that hides the block its own condition reads: it can never settle, which publish reports as `logic_cycle`. */
export function withLogicCycle(def: FormDefinition, blockId: string): FormDefinition {
  const rule = {
    id: 'rule_self',
    enabled: true,
    when: {
      kind: 'group',
      id: 'group_self',
      combinator: 'all',
      children: [{ kind: 'condition', id: 'cond_self', left: { kind: 'ref', ref: { kind: 'answer', blockId } }, op: 'is_answered' }],
    },
    then: [{ type: 'hide', targets: [blockId] }],
  };
  return { ...def, logic: { ...def.logic, rules: [...def.logic.rules, rule] } } as unknown as FormDefinition;
}

/** `publishableDraft` with `blocks` placed on its one page. */
export function draftWith(formId: string, blocks: Array<ReturnType<typeof fieldBlock>>, title = 'Live form'): FormDefinition {
  const base = publishableDraft(formId, title);
  return {
    ...base,
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    pages: [{ ...base.pages[0]!, children: blocks.map((b) => b.id) }],
  } as unknown as FormDefinition;
}
