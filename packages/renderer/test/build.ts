import { DEFAULT_COMPLIANCE, REGISTRY, type AvailableType } from '@form/registry';
import { compile, projectForRuntime } from '@form/logic';
import { migrateV1ToV2, parseV1 } from '@form/schema';
import type * as S from '@form/schema';
import { V1_FIXTURES, migrationContext } from '@form/schema/migration-fixtures';
import type { FormRendererProps, UploadRequest } from '../src/index.ts';

/* Builders for v2 definitions and runtime versions in the renderer tests. */

export const id = <T extends string>(v: string) => v as T;
export const EN_IN = id<S.Locale>('en-IN');
export const STARTED_AT = id<S.IsoInstant>('2026-10-19T04:30:00Z');
export const RESPOND = id<S.PurposeId>('respond');

export const inline = (text: string): S.InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
export const rich = (...paragraphs: string[]): S.RichDoc => ({ type: 'doc', content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

export function field<T extends S.ValueFieldType>(
  type: T,
  blockId: string,
  extra: Omit<Partial<S.FieldBlockOf<T>>, 'config'> & { config?: Partial<S.BlockConfigMap[T]> } = {},
): S.FieldBlockOf<T> {
  const { config, ...rest } = extra;
  const compliance = DEFAULT_COMPLIANCE[type];
  return {
    id: id<S.BlockId>(blockId),
    type,
    key: id<S.FieldKey>(blockId.toLowerCase().replace(/[^a-z0-9_]/g, '_')),
    label: inline(blockId),
    required: false,
    compliance: { ...compliance, purposeIds: compliance.classification === 'none' ? [] : [RESPOND] },
    config: { ...REGISTRY[type].defaultConfig(EN_IN), ...config },
    ...rest,
  } as S.FieldBlockOf<T>;
}

export const content = <T extends 'heading' | 'paragraph' | 'divider'>(type: T, blockId: string, config?: Partial<S.BlockConfigMap[T]>): S.PlainBlockOf<T> =>
  ({ id: id<S.BlockId>(blockId), type, config: { ...REGISTRY[type].defaultConfig(EN_IN), ...config } }) as S.PlainBlockOf<T>;

export const page = (pageId: string, children: string[], extra: Partial<S.Page> = {}): S.Page => ({ id: id<S.PageId>(pageId), children: children.map((c) => id<S.BlockId>(c)), ...extra });

let counter = 0;
const cid = () => id<S.ConditionId>(`c${(counter += 1)}`);

export function when(blockId: string, op: S.LogicOperator, right?: S.Operand): S.ConditionGroup {
  const condition: S.Condition = { kind: 'condition', id: cid(), left: { kind: 'ref', ref: { kind: 'answer', blockId: id<S.BlockId>(blockId) } }, op };
  if (right) condition.right = right;
  return { kind: 'group', id: cid(), combinator: 'all', children: [condition] };
}
export const options = (blockId: string, ...ids: string[]): S.Operand => ({ kind: 'options', blockId: id<S.BlockId>(blockId), optionIds: ids.map((o) => id<S.OptionId>(o)) });
export const rule = (ruleId: string, condition: S.ConditionGroup, then: S.Action[]): S.Rule => ({ id: id<S.RuleId>(ruleId), enabled: true, when: condition, then });
export const show = (...targets: string[]): S.ClientAction => ({ type: 'show', targets: targets as S.ElementTarget[] });

const plain = (t: string): S.PlainTemplate => [t];

export function form(blocks: S.StoredBlock[], pages: S.Page[], rules: S.Rule[] = [], extra: Partial<S.FormDefinition> = {}): S.FormDefinition {
  const ending = id<S.EndingId>('ending_1');
  return {
    schemaVersion: 2,
    revision: 0,
    formId: id<S.FormId>('form_1'),
    title: 'Renderer fixture',
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    pages,
    endings: [{ id: ending, kind: 'message', name: 'Thanks', content: rich('Thanks for your response!'), actions: [{ kind: 'fill_again', prefill: 'none' }] }],
    defaultEndingId: ending,
    logic: { rules, ruleGroups: [], variables: [] },
    privacy: {
      fiduciary: {
        legalName: plain('Acme Pvt Ltd'),
        contactEmail: plain('privacy@acme.example'),
        privacyContact: { name: plain('Priya'), email: plain('privacy@acme.example') },
        rightsUrl: plain('https://acme.example/rights'),
        boardComplaintInfo: plain('You may complain to the Data Protection Board of India.'),
      },
      purposes: [{
        id: RESPOND,
        name: 'Respond to this form',
        description: inline('Respond to this form.'),
        lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: 'The respondent asked us to' },
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
      submit: { label: 'Submit', align: 'left' },
      navigation: { allowBack: true, showPageTitles: false },
      saveAndResume: { enabled: false, showButton: false, delivery: [], expiryDays: 30 },
      localAutosave: { enabled: false, allowWithSensitive: false },
      timeZone: id<S.TimeZone>('Asia/Kolkata'),
      spam: { honeypot: true, minFillSeconds: 3, captcha: 'off' },
      urlPrefill: false,
      showBranding: true,
      a11y: { announceErrors: 'polite', focusFirstError: true },
      successAnimation: false,
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

const PUBLIC_CONFIG: S.RuntimeFormVersion['publicConfig'] = { edition: 'saas', upload: { presignUrl: '', maxFileBytes: 10 * 1024 * 1024 }, branding: false, thirdPartyTrackingAllowed: false };

/** compile() and projectForRuntime(), as publish and the runtime would. */
export function runtime(definition: S.FormDefinition, status: S.RuntimeStatus = { state: 'open' }): S.RuntimeFormVersion {
  const result = compile(definition, REGISTRY);
  if (!result.ok) throw new Error(`fixture does not compile: ${result.issues.map((i) => `${i.code} ${i.path} ${i.message}`).join('; ')}`);
  const version: S.FormVersion = {
    id: id<S.FormVersionId>('version_1'),
    orgId: id<S.OrgId>('org_1'),
    formId: definition.formId,
    number: 1,
    schemaVersion: 2,
    publishedAt: STARTED_AT,
    publishedBy: id<S.UserId>('user_1'),
    definition,
    compiled: result.compiled,
    contentHash: result.compiled.definitionHash,
    templateLineage: [],
    variablesSnapshot: { variables: {} },
  };
  return projectForRuntime(version, status, PUBLIC_CONFIG);
}

/** Every available type, labelled and described, on two pages. */
export function kitchenSink(): S.FormDefinition {
  const describe = <B extends S.FieldBlock>(block: B): B => ({ ...block, label: inline(`${block.type} question`), description: rich(`About the ${block.type} question.`) });
  const values: S.FieldBlock[] = [
    describe(field('short_text', 'short', { required: true, config: { placeholder: 'Your name', prefix: 'Dr', suffix: 'MD' } })),
    describe(field('long_text', 'long', { config: { showCounter: true, limit: { unit: 'words', max: 50 } } })),
    describe(field('email', 'email', { required: true })),
    describe(field('phone', 'phone')),
    describe(field('number', 'number', { config: { min: id<S.DecimalString>('1'), max: id<S.DecimalString>('10') } })),
    describe(field('url', 'url')),
    describe(field('single_choice', 'radio', { config: { display: 'radio', options: REGISTRY.single_choice.defaultConfig(EN_IN).options, other: { enabled: true, textRequired: false } } })),
    describe(field('single_choice', 'select', { config: { display: 'dropdown' } })),
    describe(field('multi_choice', 'checks', { config: { display: 'checkbox', columns: 2 } })),
    describe(field('multi_choice', 'multi', { config: { display: 'dropdown' } })),
    describe(field('date', 'date')),
    describe(field('time', 'time')),
    describe(field('time', 'range', { config: { range: { enabled: true } } })),
    describe(field('rating', 'rating', { required: true, config: { lowLabel: 'Poor', highLabel: 'Great' } })),
    describe(field('linear_scale', 'scale', { config: { min: 0, max: 5, lowLabel: 'Low', highLabel: 'High' } })),
    describe(field('nps', 'nps')),
    describe(field('ranking', 'ranking')),
    describe(field('matrix', 'matrix')),
    describe(field('file_upload', 'file')),
    describe(field('signature', 'signature', { config: { statement: inline('I confirm these answers.') } })),
    field('hidden', 'utm'),
  ];
  const plain: S.StoredBlock[] = [
    content('heading', 'title', { level: 1, text: inline('About you'), subheading: inline('A few questions') }),
    content('paragraph', 'intro', { content: rich('Answer what you can.') }),
    content('divider', 'rule'),
  ];
  const first = ['title', 'intro', 'short', 'long', 'email', 'phone', 'number', 'url', 'rule', 'radio', 'select', 'checks', 'multi', 'utm'];
  const second = ['date', 'time', 'range', 'rating', 'scale', 'nps', 'ranking', 'matrix', 'file', 'signature'];
  return form([...plain, ...values], [page('page_1', first), page('page_2', second)], [], { description: rich('Kitchen sink of every available type.') });
}

export const AVAILABLE_IN_SINK: readonly AvailableType[] = [
  'short_text', 'long_text', 'email', 'phone', 'number', 'url', 'single_choice', 'multi_choice', 'date', 'time', 'rating',
  'linear_scale', 'nps', 'ranking', 'matrix', 'file_upload', 'signature', 'hidden', 'heading', 'paragraph', 'divider',
];

export interface Fixture { name: string; version: S.RuntimeFormVersion }

const EMPTY: S.RichDoc = { type: 'doc', content: [] };

/** The 35-form WP-0.05 corpus migrated, compiled and projected; closed and password forms keep that status. */
export function corpus(): Fixture[] {
  return V1_FIXTURES.map(({ name, doc }) => {
    const parsed = parseV1(doc);
    if (!parsed.success) throw new Error(`${name}: ${parsed.error}`);
    const result = migrateV1ToV2(parsed.data, migrationContext(REGISTRY));
    const status: S.RuntimeStatus = !result.ops.access.enabled
      ? { state: 'closed', screen: result.ops.access.screens.closed?.content ?? EMPTY }
      : result.plaintextPasswordToHash !== undefined ? { state: 'password', screen: EMPTY } : { state: 'open' };
    return { name, version: runtime(result.definition, status) };
  });
}

let files = 0;
/** A fake `uploader`: records each request and returns a reference with a fresh id. */
export function fakeUploader() {
  const requests: UploadRequest[] = [];
  const uploader: FormRendererProps['uploader'] = (request) => {
    requests.push(request);
    files += 1;
    return Promise.resolve({
      fileId: id<S.FileId>(`file_${files}`),
      name: request.name,
      sizeBytes: request.file.size,
      mime: request.file.type,
      sha256: id<S.Sha256Hex>('0'.repeat(64)),
    });
  };
  return { uploader, requests };
}

/** Props for a test render; `onSubmit` records payloads. */
export function props(version: S.RuntimeFormVersion, extra: Partial<FormRendererProps> = {}): FormRendererProps {
  return {
    version,
    mode: 'live',
    status: version.status,
    locale: EN_IN,
    uploader: fakeUploader().uploader,
    onSubmit: () => undefined,
    session: { startedAt: STARTED_AT },
    ...extra,
  };
}
