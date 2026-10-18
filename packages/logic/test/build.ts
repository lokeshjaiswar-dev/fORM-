import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import { contentHash } from '@form/schema';
import type * as S from '@form/schema';
import { compile } from '../src/index.ts';

/* Small builders for v2 definitions, rules and answers in tests and in the determinism corpus. */

export const id = <T extends string>(v: string) => v as T;
export const EN_IN = id<S.Locale>('en-IN');
export const bid = (v: string) => id<S.BlockId>(v);
export const pid = (v: string) => id<S.PageId>(v);
export const oid = (v: string) => id<S.OptionId>(v);

export const inline = (text: string): S.InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

export const RESPOND = id<S.PurposeId>('respond');

export function field<T extends S.ValueFieldType>(type: T, blockId: string, extra: Partial<S.FieldBlockOf<T>> = {}): S.FieldBlockOf<T> {
  const { config, ...rest } = extra as { config?: Partial<S.BlockConfigMap[T]> };
  const compliance = DEFAULT_COMPLIANCE[type];
  return {
    id: bid(blockId),
    type,
    key: id<S.FieldKey>(blockId.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([^a-z])/, 'f_$1')),
    label: inline(blockId),
    required: false,
    compliance: { ...compliance, purposeIds: compliance.classification === 'none' ? [] : [RESPOND] },
    config: { ...REGISTRY[type].defaultConfig(EN_IN), ...config },
    ...rest,
  } as S.FieldBlockOf<T>;
}

export const heading = (blockId: string): S.PlainBlockOf<'heading'> => ({ id: bid(blockId), type: 'heading', config: { level: 2, text: inline(blockId) } });

export const choices = (...ids: string[]): S.ChoiceOption[] => ids.map((o) => ({ id: oid(o), label: o }));

export const page = (pageId: string, children: string[], extra: Partial<S.Page> = {}): S.Page => ({ id: pid(pageId), children: children.map(bid), ...extra });

let counter = 0;
const cid = () => id<S.ConditionId>(`c${(counter += 1)}`);

export const ans = (blockId: string, path?: string): S.Operand => ({ kind: 'ref', ref: path === undefined ? { kind: 'answer', blockId: bid(blockId) } : { kind: 'answer', blockId: bid(blockId), path } });
export const meta = (key: S.MetaKey, name?: string): S.Operand => ({ kind: 'ref', ref: name === undefined ? { kind: 'meta', key } : { kind: 'meta', key, name } });
export const text = (value: string): S.Operand => ({ kind: 'literal', value: { type: 'text', value } });
export const num = (value: string): S.Operand => ({ kind: 'literal', value: { type: 'number', value: id<S.DecimalString>(value) } });
export const bool = (value: boolean): S.Operand => ({ kind: 'literal', value: { type: 'boolean', value } });
export const date = (value: string): S.Operand => ({ kind: 'literal', value: { type: 'date', value: id<S.IsoDate>(value) } });
export const time = (value: string): S.Operand => ({ kind: 'literal', value: { type: 'time', value: id<S.IsoTime>(value) } });
export const nil = (): S.Operand => ({ kind: 'literal', value: { type: 'null' } });
export const opts = (blockId: string, ...ids: string[]): S.Operand => ({ kind: 'options', blockId: bid(blockId), optionIds: ids.map(oid) });
export const expr = (e: S.Expr): S.Operand => ({ kind: 'expr', expr: e });

export function cond(left: S.Operand, op: S.LogicOperator, right?: S.Operand, extra: Partial<S.Condition> = {}): S.Condition {
  const c: S.Condition = { kind: 'condition', id: cid(), left, op, ...extra };
  if (right) c.right = right;
  return c;
}
export const all = (...children: Array<S.Condition | S.ConditionGroup>): S.ConditionGroup => ({ kind: 'group', id: cid(), combinator: 'all', children });
export const any = (...children: Array<S.Condition | S.ConditionGroup>): S.ConditionGroup => ({ kind: 'group', id: cid(), combinator: 'any', children });

export const show = (...targets: string[]): S.ClientAction => ({ type: 'show', targets: targets as S.ElementTarget[] });
export const hide = (...targets: string[]): S.ClientAction => ({ type: 'hide', targets: targets as S.ElementTarget[] });
export const requireIt = (...targets: string[]): S.ClientAction => ({ type: 'require', targets: targets.map(bid) });
export const unrequire = (...targets: string[]): S.ClientAction => ({ type: 'unrequire', targets: targets.map(bid) });
export const enable = (...targets: string[]): S.ClientAction => ({ type: 'enable', targets: targets.map(bid) });
export const disable = (...targets: string[]): S.ClientAction => ({ type: 'disable', targets: targets.map(bid) });

export function rule(ruleId: string, when: S.ConditionGroup | S.Condition, then: S.Action[], otherwise?: S.Action[], extra: Partial<S.Rule> = {}): S.Rule {
  const r: S.Rule = { id: id<S.RuleId>(ruleId), enabled: true, when: when.kind === 'group' ? when : all(when), then, ...extra };
  if (otherwise) r.else = otherwise;
  return r;
}

const plain = (t: string): S.PlainTemplate => [t];

export function form(blocks: S.StoredBlock[], pages: S.Page[], rules: S.Rule[] = [], extra: Partial<S.FormDefinition> = {}): S.FormDefinition {
  const ending = id<S.EndingId>('ending_1');
  return {
    schemaVersion: 2,
    revision: 0,
    formId: id<S.FormId>('form_1'),
    title: 'Logic fixture',
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    pages,
    endings: [{ id: ending, kind: 'message', name: 'Thanks', content: { type: 'doc', content: [] }, actions: [] }],
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

export const META: S.EvalMeta = {
  now: id<S.IsoInstant>('2026-10-18T06:30:00Z'),
  timeZone: id<S.TimeZone>('Asia/Kolkata'),
  locale: EN_IN,
  urlParams: {},
  isPreview: false,
  shuffleSeed: 'seed',
};

export function compiled(def: S.FormDefinition): S.CompiledForm {
  const result = compile(def, REGISTRY);
  if (!result.ok) throw new Error(`fixture does not compile: ${result.issues.filter((i) => i.severity === 'error' || i.code === 'missing_capability').map((i) => `${i.code} ${i.path} ${i.message}`).join('; ')}`);
  return result.compiled;
}

/** A published version of `def` (fixed ids and timestamps). */
export function versionOf(def: S.FormDefinition): S.FormVersion {
  return {
    id: id<S.FormVersionId>('version_1'),
    orgId: id<S.OrgId>('org_1'),
    formId: def.formId,
    number: 1,
    schemaVersion: 2,
    publishedAt: id<S.IsoInstant>('2026-10-18T00:00:00Z'),
    publishedBy: id<S.UserId>('user_1'),
    definition: def,
    compiled: compiled(def),
    contentHash: contentHash(def),
    templateLineage: [],
    variablesSnapshot: { variables: {} },
  };
}

/* Answers */
export const a = {
  text: (v: string): S.AnswerValue => ({ type: 'short_text', value: v }),
  long: (v: string): S.AnswerValue => ({ type: 'long_text', value: v }),
  email: (v: string): S.AnswerValue => ({ type: 'email', value: { address: id<S.EmailAddress>(v) } }),
  number: (v: string): S.AnswerValue => ({ type: 'number', value: id<S.DecimalString>(v) }),
  single: (o: string | null, other?: string): S.AnswerValue => ({ type: 'single_choice', value: other === undefined ? { optionId: o === null ? null : oid(o) } : { optionId: o === null ? null : oid(o), other } }),
  multi: (...o: string[]): S.AnswerValue => ({ type: 'multi_choice', value: { optionIds: o.map(oid) } }),
  date: (v: string): S.AnswerValue => ({ type: 'date', value: id<S.IsoDate>(v) }),
  time: (v: string): S.AnswerValue => ({ type: 'time', value: { start: id<S.IsoTime>(v) } }),
  rating: (v: number): S.AnswerValue => ({ type: 'rating', value: v }),
  nps: (v: number): S.AnswerValue => ({ type: 'nps', value: v }),
  hidden: (v: string): S.AnswerValue => ({ type: 'hidden', value: v }),
};

export const answers = (entries: Record<string, S.AnswerValue>): S.Answers => entries as S.Answers;
