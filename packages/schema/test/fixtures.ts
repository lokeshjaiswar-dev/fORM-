import type * as S from '../src/index.ts';

/* A small but complete v2 definition: two pages, a dpdp consent block, a choice field, a section and one rule. */

export const id = <T extends string>(v: string) => v as T;
export const inline = (text: string): S.InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
export const rich = (text: string): S.RichDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

export const ids = {
  page1: id<S.PageId>('page_1'),
  page2: id<S.PageId>('page_2'),
  consent: id<S.BlockId>('consent_1'),
  name: id<S.BlockId>('name_1'),
  marketing: id<S.BlockId>('marketing_1'),
  section: id<S.BlockId>('section_1'),
  heading: id<S.BlockId>('heading_1'),
  ending: id<S.EndingId>('ending_1'),
  respond: id<S.PurposeId>('respond'),
  newsletter: id<S.PurposeId>('newsletter'),
  item: id<S.ConsentItemId>('item_1'),
  yes: id<S.OptionId>('yes'),
  no: id<S.OptionId>('no'),
  rule: id<S.RuleId>('rule_1'),
  group: id<S.ConditionId>('group_1'),
  cond: id<S.ConditionId>('cond_1'),
};

const compliance = (purposeIds: S.PurposeId[]): S.FieldCompliance => ({
  classification: 'personal',
  category: 'contact',
  purposeIds,
  encrypt: false,
  allowPrefill: false,
  inNotifications: 'include',
  inExports: 'include',
});

const plain = (text: string): S.PlainTemplate => [text];

export function definition(): S.FormDefinition {
  return {
    schemaVersion: 2,
    revision: 0,
    formId: id<S.FormId>('form_1'),
    title: 'Event registration',
    blocks: {
      [ids.consent]: {
        id: ids.consent,
        type: 'consent',
        key: id<S.FieldKey>('consent'),
        label: inline('Consent'),
        required: true,
        compliance: { ...compliance([ids.respond]), classification: 'none', purposeIds: [] },
        config: {
          mode: 'dpdp',
          notice: rich('We use your details to run the event.'),
          itemiseData: true,
          items: [{ id: ids.item, purposeId: ids.newsletter, label: inline('Send me the newsletter'), requiredToSubmit: false, defaultChecked: false }],
          withdrawalText: inline('Withdraw any time from the link in your email.'),
          presentation: 'checkboxes',
          noticeVersion: 1,
        },
      },
      [ids.name]: {
        id: ids.name,
        type: 'short_text',
        key: id<S.FieldKey>('name'),
        label: inline('Your name'),
        required: true,
        compliance: compliance([ids.respond]),
        config: { maxLength: 200 },
      },
      [ids.section]: {
        id: ids.section,
        type: 'section',
        config: { title: inline('Updates'), children: [ids.heading, ids.marketing], collapsible: false },
      },
      [ids.heading]: { id: ids.heading, type: 'heading', config: { level: 2, text: inline('Stay in touch') } },
      [ids.marketing]: {
        id: ids.marketing,
        type: 'single_choice',
        key: id<S.FieldKey>('updates'),
        label: inline('Send updates?'),
        required: false,
        initiallyHidden: true,
        compliance: compliance([ids.newsletter]),
        config: {
          display: 'radio',
          options: [{ id: ids.yes, label: 'Yes' }, { id: ids.no, label: 'No' }],
          defaultOptionId: ids.no,
        },
      },
    },
    pages: [
      { id: ids.page1, children: [ids.consent, ids.name] },
      { id: ids.page2, children: [ids.section] },
    ],
    endings: [{ id: ids.ending, kind: 'message', name: 'Thanks', content: rich('Thank you!'), actions: [] }],
    defaultEndingId: ids.ending,
    logic: {
      rules: [{
        id: ids.rule,
        enabled: true,
        when: {
          kind: 'group',
          id: ids.group,
          combinator: 'all',
          children: [{ kind: 'condition', id: ids.cond, left: { kind: 'ref', ref: { kind: 'answer', blockId: ids.name } }, op: 'is_answered' }],
        },
        then: [{ type: 'show', targets: [ids.marketing] }],
      }],
      ruleGroups: [],
      variables: [],
    },
    privacy: {
      fiduciary: {
        legalName: plain('Acme Events Pvt Ltd'),
        contactEmail: plain('privacy@acme.example'),
        privacyContact: { name: plain('Priya'), email: plain('privacy@acme.example') },
        rightsUrl: plain('https://acme.example/rights'),
        boardComplaintInfo: plain('You may complain to the Data Protection Board of India.'),
      },
      purposes: [
        {
          id: ids.respond,
          name: 'Respond to this form',
          description: inline('Run the event you registered for.'),
          lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: 'Registration' },
          retention: { kind: 'org_default' },
        },
        {
          id: ids.newsletter,
          name: 'Newsletter',
          description: inline('Send event news.'),
          lawfulBasis: { kind: 'consent' },
          retention: { kind: 'days', days: 365 },
          marketing: true,
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
        colors: { accent: id<S.HexColor>('#2383e2') },
        typography: { body: id<S.FontId>('inter'), baseSizePx: 16 },
        radius: 'md',
        density: 'comfortable',
        formWidth: 'normal',
        labelAlign: 'top',
        inputStyle: 'outlined',
        progress: 'bar',
      },
    },
    behavior: {
      submit: { label: 'Register', align: 'left' },
      navigation: { allowBack: true, showPageTitles: false },
      saveAndResume: { enabled: false, showButton: false, delivery: [], expiryDays: 30 },
      localAutosave: { enabled: false, allowWithSensitive: false },
      timeZone: id<S.TimeZone>('Asia/Kolkata'),
      spam: { honeypot: true, minFillSeconds: 3, captcha: 'on_suspicion' },
      urlPrefill: false,
      showBranding: true,
      a11y: { announceErrors: 'polite', focusFirstError: true },
      successAnimation: true,
    },
    i18n: {
      defaultLocale: id<S.Locale>('en-IN'),
      locales: [{ locale: id<S.Locale>('en-IN'), direction: 'ltr' }],
      detect: ['url_param'],
      urlParam: 'lang',
      switcher: 'none',
      messages: {},
      systemMessages: {},
      reviewedConsentLocales: [id<S.Locale>('en-IN')],
    },
  };
}
