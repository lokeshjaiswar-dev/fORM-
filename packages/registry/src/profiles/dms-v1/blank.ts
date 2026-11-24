import { SCHEMA_VERSION, type EndingId, type FormDefinition, type FormId, type InlineDoc, type Locale, type PageId, type PurposeId, type RichDoc } from '@form/schema';

const inline = (text: string): InlineDoc => ({ type: 'doc', content: [text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }] });
const rich = (text: string): RichDoc => ({ type: 'doc', content: [text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }] });

/**
 * An empty, schema-valid form for callers that have no `base` (the upload child page). Ids are fixed so the same
 * elements always give the same definition. The builder passes its own `blankDefinition` as `base` instead.
 */
export function blankDmsDefinition(formId: string, title: string, locale: string): FormDefinition {
  const purposeId = 'purpose_1' as PurposeId;
  const endingId = 'ending_1' as EndingId;
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    formId: formId as FormId,
    title,
    blocks: {},
    pages: [{ id: 'page_1' as PageId, children: [] }],
    endings: [{ id: endingId, kind: 'message', name: 'Thank you', content: rich('Thanks for your response!'), actions: [{ kind: 'fill_again', prefill: 'none' }] }],
    defaultEndingId: endingId,
    logic: { rules: [], ruleGroups: [], variables: [] },
    privacy: {
      fiduciary: {
        legalName: [{ var: { name: 'org.legal_name' } }],
        contactEmail: [{ var: { name: 'org.support_email' } }],
        privacyContact: { name: [{ var: { name: 'org.privacy_contact.name' } }], email: [{ var: { name: 'org.privacy_contact.email' } }] },
        rightsUrl: [{ var: { name: 'org.rights_url' } }],
        boardComplaintInfo: [{ var: { name: 'org.board_complaint_info' } }],
      },
      purposes: [{
        id: purposeId,
        name: 'Respond to this form',
        description: inline('Read and act on what you send in this form.'),
        lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: 'The respondent provides these details to have this form handled.' },
        retention: { kind: 'org_default' },
      }],
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
      timeZone: 'Asia/Kolkata' as FormDefinition['behavior']['timeZone'],
      spam: { honeypot: true, minFillSeconds: 3, captcha: 'off' },
      urlPrefill: false,
      showBranding: false,
      a11y: { announceErrors: 'polite', focusFirstError: true },
      successAnimation: false,
    },
    i18n: {
      defaultLocale: locale as Locale,
      locales: [{ locale: locale as Locale, direction: 'ltr' }],
      detect: ['url_param'],
      urlParam: 'lang',
      switcher: 'none',
      messages: {},
      systemMessages: {},
      reviewedConsentLocales: [],
    },
  };
}
