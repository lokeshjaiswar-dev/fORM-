import type * as S from '@form/schema';
import { DEFAULT_COMPLIANCE, REGISTRY } from '../src/index.ts';

export const id = <T extends string>(v: string) => v as T;
export const EN_IN = id<S.Locale>('en-IN');

export const inline = (text: string): S.InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

export function fieldBlock<T extends S.ValueFieldType>(type: T, config: Partial<S.BlockConfigMap[T]> = {}, extra: Partial<S.FieldBase<T>> = {}): S.FieldBlockOf<T> {
  return {
    id: id<S.BlockId>(`${type}_1`),
    type,
    key: id<S.FieldKey>(type),
    label: inline(`My ${type.replace(/_/g, ' ')}`),
    required: false,
    compliance: { ...DEFAULT_COMPLIANCE[type], purposeIds: [] },
    config: { ...REGISTRY[type].defaultConfig(EN_IN), ...config },
    ...extra,
  } as S.FieldBlockOf<T>;
}

export function plainBlock<T extends 'heading' | 'paragraph' | 'divider'>(type: T, config: Partial<S.BlockConfigMap[T]> = {}): S.PlainBlockOf<T> {
  return { id: id<S.BlockId>(`${type}_1`), type, config: { ...REGISTRY[type].defaultConfig(EN_IN), ...config } } as S.PlainBlockOf<T>;
}

export const file = (name: string, mime: string, sizeBytes = 1000, extra: Partial<S.FileRef> = {}): S.FileRef => ({
  fileId: id<S.FileId>(`file_${name.replace(/\W/g, '_')}`),
  name,
  sizeBytes,
  mime,
  sha256: id<S.Sha256Hex>('a'.repeat(64)),
  ...extra,
});

const plain = (text: string): S.PlainTemplate => [text];

export function definition(blocks: S.Block[], rules: S.Rule[] = []): S.FormDefinition {
  const page = id<S.PageId>('page_1');
  const ending = id<S.EndingId>('ending_1');
  return {
    schemaVersion: 2,
    revision: 0,
    formId: id<S.FormId>('form_1'),
    title: 'Registry fixture',
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    pages: [{ id: page, children: blocks.map((b) => b.id) }],
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
      purposes: [],
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
  };
}
