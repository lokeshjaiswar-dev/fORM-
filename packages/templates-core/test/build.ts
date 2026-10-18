import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import { contentHash } from '@form/schema';
import type * as S from '@form/schema';

/* Builders and fixture templates for the templates-core tests and the determinism corpus. */

export const id = <T extends string>(v: string) => v as T;
export const EN_IN = id<S.Locale>('en-IN');
export const HI_IN = id<S.Locale>('hi-IN');
export const bid = (v: string) => id<S.BlockId>(v);
export const pid = (v: string) => id<S.PageId>(v);
export const oid = (v: string) => id<S.OptionId>(v);

export const text = (t: string): S.TextNode => ({ type: 'text', text: t });
export const v = (name: S.TemplateVariableName, fallback?: string): S.VarNode => ({ type: 'var', attrs: fallback === undefined ? { name } : { name, fallback } });
export const inline = (...content: Array<string | S.InlineNode>): S.InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? text(c) : c)) }] });
export const rich = (...content: Array<string | S.InlineNode>): S.RichDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? text(c) : c)) }] });
export const pipe = (blockId: string): S.PipeNode => ({ type: 'pipe', attrs: { source: { kind: 'answer', blockId: bid(blockId) }, fallback: 'there' } });

export const RESPOND = id<S.PurposeId>('respond');
export const MARKETING = id<S.PurposeId>('marketing');
export const KYC = id<S.PurposeId>('kyc');

export function field<T extends S.ValueFieldType>(type: T, blockId: string, extra: Partial<S.FieldBlockOf<T>> = {}, purposes: S.PurposeId[] = [RESPOND]): S.FieldBlockOf<T> {
  const { config, ...rest } = extra as { config?: Partial<S.BlockConfigMap[T]> };
  const compliance = DEFAULT_COMPLIANCE[type];
  return {
    id: bid(blockId),
    type,
    key: id<S.FieldKey>(blockId),
    label: inline(blockId),
    required: false,
    compliance: { ...compliance, purposeIds: compliance.classification === 'none' ? [] : purposes },
    config: { ...REGISTRY[type].defaultConfig(EN_IN), ...config },
    ...rest,
  } as S.FieldBlockOf<T>;
}

export const section = (blockId: string, children: string[]): S.PlainBlockOf<'section'> => ({
  id: bid(blockId), type: 'section', config: { title: inline(blockId), children: children.map(bid), collapsible: false },
});

export const pan = (blockId = 'pan', key = 'pan'): S.FieldBlockOf<'short_text'> => field('short_text', blockId, {
  key: id<S.FieldKey>(key),
  label: inline('PAN'),
  config: { preset: 'in_pan' },
  compliance: { classification: 'sensitive', category: 'government_id', purposeIds: [KYC], encrypt: true, allowPrefill: false, inNotifications: 'mask', inExports: 'mask' },
}, [KYC]);

export const choices = (...ids: string[]): S.ChoiceOption[] => ids.map((o) => ({ id: oid(o), label: o }));
export const page = (pageId: string, children: string[], extra: Partial<S.Page> = {}): S.Page => ({ id: pid(pageId), children: children.map(bid), ...extra });
export const cond = (cid: string, left: S.Operand, op: S.LogicOperator, right?: S.Operand): S.Condition =>
  (right ? { kind: 'condition', id: id<S.ConditionId>(cid), left, op, right } : { kind: 'condition', id: id<S.ConditionId>(cid), left, op });
export const all = (gid: string, ...children: Array<S.Condition | S.ConditionGroup>): S.ConditionGroup => ({ kind: 'group', id: id<S.ConditionId>(gid), combinator: 'all', children });
export const ans = (blockId: string): S.Operand => ({ kind: 'ref', ref: { kind: 'answer', blockId: bid(blockId) } });
export const opts = (blockId: string, ...o: string[]): S.Operand => ({ kind: 'options', blockId: bid(blockId), optionIds: o.map(oid) });
export const rule = (ruleId: string, when: S.ConditionGroup, then: S.Action[], extra: Partial<S.Rule> = {}): S.Rule => ({ id: id<S.RuleId>(ruleId), enabled: true, when, then, ...extra });

const plain = (t: string): S.PlainTemplate => [t];

const respond = (): S.Purpose => ({
  id: RESPOND,
  name: 'Respond to this form',
  description: inline('Respond to this form.'),
  lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: 'The respondent asked us to' },
  retention: { kind: 'days', days: 365 },
});
export const kycPurpose: S.Purpose = {
  id: KYC,
  name: 'Verify identity',
  description: inline('Know-your-customer checks.'),
  lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: 'Required to open the account' },
  retention: { kind: 'statutory', years: 5, citation: 'PMLA s.12' },
};

export function form(blocks: S.StoredBlock[], pages: S.Page[], rules: S.Rule[] = [], extra: Partial<S.FormDefinition> = {}): S.FormDefinition {
  const ending = id<S.EndingId>('ending_1');
  return {
    schemaVersion: 2,
    revision: 0,
    formId: id<S.FormId>('form_1'),
    title: 'Fixture',
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    pages,
    endings: [{ id: ending, kind: 'message', name: 'Thanks', content: rich('Thanks!'), actions: [] }],
    defaultEndingId: ending,
    logic: { rules, ruleGroups: [], variables: [] },
    privacy: {
      fiduciary: {
        legalName: plain('Acme Pvt Ltd'),
        contactEmail: plain('privacy@acme.example'),
        privacyContact: { name: plain('Priya Raman'), email: plain('privacy@acme.example') },
        rightsUrl: plain('https://acme.example/rights'),
        boardComplaintInfo: plain('You may complain to the Data Protection Board of India.'),
      },
      purposes: [respond()],
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
        radius: 'md', density: 'comfortable', formWidth: 'normal', labelAlign: 'top', inputStyle: 'outlined', progress: 'bar',
      },
    },
    behavior: {
      submit: { label: 'Submit', align: 'left' },
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
      defaultLocale: EN_IN,
      locales: [{ locale: EN_IN, direction: 'ltr' }],
      detect: ['url_param'],
      urlParam: 'lang',
      switcher: 'none',
      messages: {},
      systemMessages: {},
      reviewedConsentLocales: [EN_IN],
    },
    ...extra,
  };
}

const entry = (value: S.TranslationEntry['value']): S.TranslationEntry => ({ value, sourceHash: contentHash(value), origin: 'human' });

const templateCommon = (variables: S.TemplateVariable[] = []) => ({
  schemaVersion: 2,
  variables,
  locks: [] as S.LockSpec[],
  requiredFeatures: [] as S.FeatureId[],
  i18n: { defaultLocale: EN_IN, locales: [{ locale: EN_IN, direction: 'ltr' as const }], messages: {} },
});

export const EVENT_VARIABLES: S.TemplateVariable[] = [
  { name: 'org.legal_name', source: 'org_profile', type: 'text', label: 'Legal name', required: true, binding: 'live' },
  { name: 'custom.event_name', source: 'prompt', type: 'text', label: 'Event name', required: true, binding: 'bake' },
  { name: 'custom.venue', source: 'prompt', type: 'text', label: 'Venue', required: false, binding: 'bake' },
  { name: 'custom.dietary', source: 'prompt', type: 'boolean', label: 'Ask about dietary needs?', required: false, default: true, binding: 'bake' },
];

/** The event-registration form template: two pages, a section, rules, an optional part, translations and every kind of ref. */
export function eventPayload(): S.FormTemplatePayload {
  const blocks: S.StoredBlock[] = [
    { id: bid('intro'), type: 'heading', config: { level: 1, text: inline('Register for ', v('custom.event_name')), subheading: inline('Hosted by ', v('org.legal_name')) } },
    field('short_text', 'name', { label: inline('Name for ', v('custom.event_name')), required: true }),
    field('email', 'email', { required: true }),
    field('phone', 'phone'),
    field('single_choice', 'diet', { config: { display: 'radio', options: choices('veg', 'nonveg') } }),
    field('long_text', 'diet_notes', { initiallyHidden: true }),
    section('kyc', ['pan_number']),
    pan('pan_number', 'pan'),
    { id: bid('greeting'), type: 'paragraph', config: { content: rich('Hello ', pipe('name'), ', see you at ', v('custom.venue', 'the venue'), '.') } },
    field('date', 'arrival', { config: { pattern: 'DD-MM-YYYY', picker: 'calendar', limits: { min: { kind: 'absolute', date: id<S.IsoDate>('2026-11-01') } } } }),
    field('date', 'departure', { config: { pattern: 'DD-MM-YYYY', picker: 'calendar', limits: { min: { kind: 'field', blockId: bid('arrival') } } } }),
    field('hidden', 'utm', { config: { source: { kind: 'utm', param: 'source' } } }),
  ];
  const document = form(blocks, [
    page('p1', ['intro', 'name', 'email', 'phone', 'diet', 'diet_notes'], { title: ['About you at ', { var: { name: 'custom.event_name' } }] }),
    page('p2', ['kyc', 'greeting', 'arrival', 'departure', 'utm']),
  ], [
    rule('r_diet', all('g_diet', cond('c_diet', ans('diet'), 'eq', opts('diet', 'nonveg'))), [{ type: 'show', targets: [bid('diet_notes')] }], { groupId: id<S.RuleGroupId>('grp') }),
    rule('r_phone', all('g_phone', cond('c_phone', ans('email'), 'is_answered')), [{ type: 'require', targets: [bid('phone')] }], { groupId: id<S.RuleGroupId>('grp') }),
    rule('r_pan', all('g_pan', cond('c_pan', ans('diet'), 'is_answered')), [{ type: 'hide', targets: [bid('kyc'), bid('diet_notes')] }]),
  ], {
    title: 'Event registration',
    endings: [{ id: id<S.EndingId>('ending_1'), kind: 'message', name: 'Thanks', content: rich('See you at ', v('custom.event_name'), ', ', pipe('name'), '!'), actions: [{ kind: 'fill_again', prefill: { carryKeys: [id<S.FieldKey>('email')] } }] }],
  });
  document.logic.ruleGroups = [{ id: id<S.RuleGroupId>('grp'), name: 'Contact' }];
  document.privacy.purposes.push({ ...kycPurpose });
  document.behavior.analytics = { ga4: 'G-TEMPLATE1', requiresPurposeId: RESPOND };
  document.i18n.locales.push({ locale: HI_IN, direction: 'ltr' });
  document.i18n.reviewedConsentLocales.push(HI_IN);
  document.i18n.messages[HI_IN] = {
    'block:name:label': entry(inline('नाम (', v('custom.event_name'), ')')),
    'option:diet/veg': entry('शाकाहारी'),
    'page:p1:title': entry('आपके बारे में'),
    'rule:r_diet:0': entry('rule text'),
    'purpose:respond:name': entry('फ़ॉर्म का उत्तर'),
    'ending:ending_1:content': entry(rich('धन्यवाद ', pipe('name'))),
    'form:title': entry('कार्यक्रम पंजीकरण'),
  };
  return {
    ...templateCommon(EVENT_VARIABLES),
    kind: 'form',
    document,
    refs: {
      theme: themePayload(),
      endings: [
        { ...templateCommon(), kind: 'ending', role: 'thank_you', content: rich('Booked for ', v('custom.event_name'), '. Bye ', pipe('name')), actions: [], confetti: true },
        { ...templateCommon(), kind: 'ending', role: 'closed', content: rich('Registrations for ', v('custom.event_name'), ' are closed.'), actions: [] },
      ],
      emails: [
        {
          ...templateCommon(),
          kind: 'email',
          role: 'autoresponder',
          subject: ['You are registered for ', { var: { name: 'custom.event_name' } }],
          body: { type: 'email_doc', content: [{ type: 'paragraph', content: [text('Hi '), pipe('name')] }, { type: 'answersTable', attrs: { include: [bid('name'), bid('email')], hideEmpty: true, maskSensitive: true } }] },
          defaultRecipients: [{ kind: 'field', blockId: bid('email') }],
          includeWithdrawalLink: false,
        },
        { ...templateCommon(), kind: 'email', role: 'notification', subject: ['New registration'], body: { type: 'email_doc', content: [{ type: 'answersTable', attrs: { include: 'all', hideEmpty: false, maskSensitive: true } }] } },
        { ...templateCommon(), kind: 'email', role: 'otp', subject: ['Your code'], body: { type: 'email_doc', content: [] } },
      ],
      pdf: [{
        ...templateCommon(),
        kind: 'pdf',
        layout: {
          pageSize: 'A4', orientation: 'portrait', marginsMm: { top: 20, right: 15, bottom: 20, left: 15 },
          footer: rich(v('org.legal_name')), fields: { mode: 'all' }, hideEmpty: true, maskSensitive: true, passwordFrom: { blockId: bid('phone') },
        },
      }],
      workflow: {
        ...templateCommon(),
        kind: 'workflow',
        workflow: {
          id: id<S.WorkflowId>('wf'),
          name: 'Approve',
          start: id<S.WorkflowStepId>('s1'),
          steps: [
            { id: id<S.WorkflowStepId>('s1'), kind: 'branch', name: 'Diet?', branches: [{ when: all('g_wf', cond('c_wf', ans('diet'), 'is_answered')), next: id<S.WorkflowStepId>('s2') }], otherwise: id<S.WorkflowStepId>('s2') },
            { id: id<S.WorkflowStepId>('s2'), kind: 'approval', name: 'Owner', approver: { kind: 'field', blockId: bid('email') }, onApprove: 'end_approved', onDeny: 'end_denied' },
          ],
        },
      },
    },
    sampleAnswers: {},
    dataInventory: [{ purposeName: 'Respond to this form', fieldSourceIds: ['name', 'email'], classification: 'personal', encrypted: false }],
    estimatedMinutes: 3,
    optionalParts: [{ id: id<S.TemplatePartId>('part_diet'), label: 'Dietary preferences', when: { variable: 'custom.dietary', equals: true }, includes: { blockSourceIds: ['diet', 'diet_notes'], ruleSourceIds: ['r_diet'] } }],
    locks: [
      { id: id<S.LockId>('lock_pan'), target: { kind: 'block', sourceId: 'kyc' }, modes: ['content', 'structure', 'presence'], reason: 'KYC block' },
      { id: id<S.LockId>('lock_purpose'), target: { kind: 'purpose', sourceId: KYC }, modes: ['content'], reason: 'Approved purpose' },
    ],
  };
}

export function themePayload(): S.ThemeTemplatePayload {
  return {
    ...templateCommon(),
    kind: 'theme',
    layout: 'cards',
    tokens: {
      colors: { accent: { ref: 'brand.primary' }, page: id<S.HexColor>('#fafafa') },
      typography: { body: id<S.FontId>('noto-sans'), baseSizePx: 17 },
      radius: 'lg', density: 'comfortable', formWidth: 'narrow', labelAlign: 'top', inputStyle: 'filled', progress: 'steps',
    },
    customCss: '.fr-root h1 { letter-spacing: 0.01em; }',
  };
}

const blockMap = (blocks: S.Block[]): S.SnippetTemplatePayload['blocks'] => Object.fromEntries(blocks.map((b) => [b.id, b]));

/** The KYC section snippet: a section with a PAN and a name-on-PAN field, a rule, and the KYC purpose. */
export function kycSnippet(): S.SnippetTemplatePayload {
  const panName = field('short_text', 'pan_name', { label: inline('Name on PAN') }, [KYC]);
  return {
    ...templateCommon([{ name: 'custom.bank', source: 'prompt', type: 'text', label: 'Bank', required: false, default: 'our bank', binding: 'bake' }]),
    kind: 'snippet',
    rootId: bid('kyc'),
    blocks: blockMap([{ ...section('kyc', ['pan', 'pan_name']), config: { title: inline('KYC for ', v('custom.bank')), children: [bid('pan'), bid('pan_name')], collapsible: false } }, pan(), panName]),
    rules: [rule('r_kyc', all('g_kyc', cond('c_kyc', ans('pan'), 'is_answered')), [{ type: 'require', targets: [bid('pan_name')] }])],
    logicVariables: [],
    purposes: [{ ...kycPurpose }],
    insertHints: { preferredPosition: 'end', oncePerForm: false },
    i18n: {
      defaultLocale: EN_IN,
      locales: [{ locale: EN_IN, direction: 'ltr' }, { locale: HI_IN, direction: 'ltr' }],
      messages: { [HI_IN]: { 'block:pan:label': entry(inline('पैन')), 'rule:r_kyc:0': entry('x'), 'tplvar:custom.bank:label': entry('बैंक') } },
    },
  };
}

/** A single-block snippet that may be inserted once per form (the P1 Consent shape). */
export function onceSnippet(): S.SnippetTemplatePayload {
  return {
    ...templateCommon(),
    kind: 'snippet',
    rootId: bid('terms'),
    blocks: blockMap([field('consent', 'terms', {}, [RESPOND])]),
    rules: [],
    logicVariables: [],
    purposes: [],
    insertHints: { preferredPosition: 'start', oncePerForm: true },
  };
}

export function versionOf(payload: S.TemplateVersionPayload, templateId = 'tpl_event', versionId = 'tplv_event_1'): S.TemplateVersion {
  return {
    id: id<S.TemplateVersionId>(versionId),
    templateId: id<S.TemplateId>(templateId),
    orgId: null,
    version: 1,
    state: 'published',
    schemaVersion: 2,
    payload,
    payloadHash: contentHash(payload),
    lockFingerprints: {},
    requiredFeatures: payload.requiredFeatures,
    locales: [EN_IN],
    mandatory: false,
    stats: { fields: 0, pages: 0, estMinutes: 1, hasSensitive: false },
    createdAt: id<S.IsoInstant>('2026-10-18T00:00:00Z'),
  };
}

export const ORG_PROFILE: S.OrgProfile = {
  orgId: id<S.OrgId>('org_acme'),
  displayName: 'Acme',
  legalName: 'Acme Pvt Ltd',
  supportEmail: id<S.EmailAddress>('support@acme.example'),
  privacyContact: { name: 'Priya Raman', email: id<S.EmailAddress>('privacy@acme.example') },
  localized: { [HI_IN]: { legal_name: 'एक्मे प्रा. लि.' } },
  updatedAt: id<S.IsoInstant>('2026-10-01T00:00:00Z'),
  updatedBy: id<S.UserId>('user_admin'),
};

export function context(extra: Partial<S.InstantiateContext> = {}): S.InstantiateContext {
  return {
    newFormId: id<S.FormId>('form_new'),
    idSeed: 'idem-key-1',
    bindingIdSeed: 'binding-seed-1',
    locale: EN_IN,
    extraLocales: [HI_IN],
    orgProfile: ORG_PROFILE,
    brandKit: null,
    variables: { 'custom.event_name': 'Diwali Mela' },
    include: { theme: true, emails: true, endings: true, pdf: true, workflow: true },
    now: id<S.IsoInstant>('2026-10-18T10:00:00Z'),
    ...extra,
  };
}

/** A small existing form to insert snippets into: it already uses the key `pan`. */
export function hostForm(): S.FormDefinition {
  const def = form([field('short_text', 'full', { label: inline('Full name') }), pan('old_pan', 'pan'), section('box', ['inner']), field('short_text', 'inner')], [page('p1', ['full', 'old_pan']), page('p2', ['box'])]);
  def.privacy.purposes.push({ ...kycPurpose });
  def.i18n.locales.push({ locale: HI_IN, direction: 'ltr' });
  return def;
}
