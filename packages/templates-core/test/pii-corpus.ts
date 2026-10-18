import type * as S from '@form/schema';
import type { PiiKind } from '../src/index.ts';
import { bid, choices, field, form, id, inline, page, rich, rule, all, cond, ans } from './build.ts';

/*
 * The save-as-template sanitiser corpus (WP-T0.2): 42 forms, each with PII planted in a different place a
 * template can carry text (defaults, hidden values, rich text, options, labels, logic literals, purposes,
 * translations, emails, PDFs, status screens, links, notes) or carries verbatim (`x-*` extensions, an
 * unsupported block's `raw`). Every planted value must be reported at its path.
 */

const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

/** `first11` plus its Verhoeff check digit: a well-formed (synthetic) Aadhaar number. */
export function aadhaar(first11: string): string {
  let c = 0;
  for (let i = 0; i < first11.length; i += 1) c = D[c]?.[P[(i + 1) % 8]?.[Number(first11[first11.length - 1 - i])] ?? 0] ?? 0;
  return `${first11}${INV[c]}`;
}
const spaced = (n: string) => `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`;

export const PII = {
  email: 'ravi.kumar@example.com',
  email2: 'meena+events@mail.example.org',
  phone: '+91 98765 43210',
  phone2: '09812345678',
  phone3: '+91-98765-43210',
  phone4: '9123456789',
  pan: 'ABCPK1234F',
  pan2: 'aaapl1234c',
  aadhaar: aadhaar('23456789012'),
  aadhaar2: spaced(aadhaar('49876543210')),
  aadhaar3: aadhaar('81234567890').replace(/^(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3'),
  gstin: '27ABCPK1234F1Z5',
  gstin2: '29AAACB1234C1ZV',
} as const;

export interface PiiCase {
  name: string;
  def: S.FormDefinition;
  ops?: Pick<S.FormOps, 'notifications' | 'pdfTemplates'> & { access: Pick<S.AccessConfig, 'screens'> };
  expected: Array<{ path: string; kind: PiiKind }>;
}

const base = (): S.FormDefinition => form(
  [field('short_text', 'q1'), field('email', 'q2'), field('single_choice', 'q3', { config: { display: 'radio', options: choices('a', 'b') } }), field('hidden', 'q4', { config: { source: { kind: 'url_param' } } })],
  [page('p1', ['q1', 'q2', 'q3', 'q4'])],
);

type Def = S.FormDefinition;
const block = <T extends S.StoredBlock['type']>(def: Def, blockId: string) => def.blocks[bid(blockId)] as Extract<S.StoredBlock, { type: T }>;
const doc = '/document';
const notification = (extra: Partial<S.NotificationConfig> = {}): S.NotificationConfig => ({
  id: id('n1'), name: 'Owner', kind: 'owner', enabled: true, trigger: 'submitted', to: [{ kind: 'role', role: 'form_owner' }], purposeIds: [],
  subject: ['New response'], body: { type: 'email_doc', content: [] }, locale: 'respondent', includeWithdrawalLink: false, ...extra,
});
const pdfTemplate = (extra: Partial<S.PdfTemplateConfig> = {}): S.PdfTemplateConfig => ({
  id: id('pdf1'), name: 'Receipt', pageSize: 'A4', orientation: 'portrait', marginsMm: { top: 10, right: 10, bottom: 10, left: 10 }, fields: { mode: 'all' }, hideEmpty: true, maskSensitive: true, ...extra,
});
const ops = (o: Partial<{ notifications: S.NotificationConfig[]; pdfTemplates: S.PdfTemplateConfig[]; screens: S.AccessConfig['screens'] }>): PiiCase['ops'] =>
  ({ notifications: o.notifications ?? [], pdfTemplates: o.pdfTemplates ?? [], access: { screens: o.screens ?? {} } });

function make(name: string, plant: (def: Def) => void, expected: PiiCase['expected'], withOps?: PiiCase['ops']): PiiCase {
  const def = base();
  plant(def);
  return withOps ? { name, def, ops: withOps, expected } : { name, def, expected };
}

export const PII_CORPUS: PiiCase[] = [
  make('short text static default: email', (d) => { block<'short_text'>(d, 'q1').config.defaultValue = { kind: 'static', value: PII.email }; }, [{ path: `${doc}/blocks/q1/config/defaultValue/value`, kind: 'email' }]),
  make('short text static default: phone', (d) => { block<'short_text'>(d, 'q1').config.defaultValue = { kind: 'static', value: PII.phone }; }, [{ path: `${doc}/blocks/q1/config/defaultValue/value`, kind: 'phone_in' }]),
  make('email default: email', (d) => { block<'email'>(d, 'q2').config.defaultValue = { kind: 'static', value: PII.email2 }; }, [{ path: `${doc}/blocks/q2/config/defaultValue/value`, kind: 'email' }]),
  make('templated default: PAN', (d) => { block<'short_text'>(d, 'q1').config.defaultValue = { kind: 'template', value: ['PAN ', PII.pan] }; }, [{ path: `${doc}/blocks/q1/config/defaultValue/value/1`, kind: 'pan' }]),
  make('hidden static value: PAN', (d) => { block<'hidden'>(d, 'q4').config.source = { kind: 'static', value: [PII.pan] }; }, [{ path: `${doc}/blocks/q4/config/source/value/0`, kind: 'pan' }]),
  make('hidden static value: spaced Aadhaar', (d) => { block<'hidden'>(d, 'q4').config.source = { kind: 'static', value: [`uid ${PII.aadhaar2}`] }; }, [{ path: `${doc}/blocks/q4/config/source/value/0`, kind: 'aadhaar' }]),
  make('paragraph: Aadhaar', (d) => { d.blocks[bid('para')] = { id: bid('para'), type: 'paragraph', config: { content: rich(`Aadhaar ${PII.aadhaar} on file`) } }; d.pages[0]?.children.push(bid('para')); }, [{ path: `${doc}/blocks/para/config/content/content/0/content/0/text`, kind: 'aadhaar' }]),
  make('paragraph: GSTIN', (d) => { d.blocks[bid('para')] = { id: bid('para'), type: 'paragraph', config: { content: rich(`Bill to GSTIN ${PII.gstin}`) } }; d.pages[0]?.children.push(bid('para')); }, [{ path: `${doc}/blocks/para/config/content/content/0/content/0/text`, kind: 'gstin' }]),
  make('heading: phone', (d) => { d.blocks[bid('h')] = { id: bid('h'), type: 'heading', config: { level: 2, text: inline(`Call ${PII.phone3}`) } }; d.pages[0]?.children.push(bid('h')); }, [{ path: `${doc}/blocks/h/config/text/content/0/content/0/text`, kind: 'phone_in' }]),
  make('heading subheading: email', (d) => { d.blocks[bid('h')] = { id: bid('h'), type: 'heading', config: { level: 2, text: inline('Hi'), subheading: inline(`Write to ${PII.email}`) } }; d.pages[0]?.children.push(bid('h')); }, [{ path: `${doc}/blocks/h/config/subheading/content/0/content/0/text`, kind: 'email' }]),
  make('option label: lowercase PAN', (d) => { const q = block<'single_choice'>(d, 'q3'); q.config.options = [{ id: id('a'), label: `Use ${PII.pan2}` }, { id: id('b'), label: 'No' }]; }, [{ path: `${doc}/blocks/q3/config/options/0/label`, kind: 'pan' }]),
  make('option label template: phone', (d) => { const q = block<'single_choice'>(d, 'q3'); q.config.options = [{ id: id('a'), label: ['Call ', PII.phone4] }, { id: id('b'), label: 'No' }]; }, [{ path: `${doc}/blocks/q3/config/options/0/label/1`, kind: 'phone_in' }]),
  make('field label: email', (d) => { block<'short_text'>(d, 'q1').label = inline(`Ask ${PII.email}`); }, [{ path: `${doc}/blocks/q1/label/content/0/content/0/text`, kind: 'email' }]),
  make('field description: phone with 0 prefix', (d) => { block<'short_text'>(d, 'q1').description = rich(`Helpline ${PII.phone2}`); }, [{ path: `${doc}/blocks/q1/description/content/0/content/0/text`, kind: 'phone_in' }]),
  make('placeholder: dashed Aadhaar', (d) => { block<'short_text'>(d, 'q1').config.placeholder = `e.g. ${PII.aadhaar3}`; }, [{ path: `${doc}/blocks/q1/config/placeholder`, kind: 'aadhaar' }]),
  make('ending message: GSTIN', (d) => { d.endings[0] = { id: id('ending_1'), kind: 'message', name: 'Thanks', content: rich(`Invoice from ${PII.gstin2}`), actions: [] }; }, [{ path: `${doc}/endings/0/content/content/0/content/0/text`, kind: 'gstin' }]),
  make('ending redirect URL: email', (d) => { d.endings[0] = { id: id('ending_1'), kind: 'redirect', name: 'Go', url: [`https://shop.example/?ref=${PII.email}`] }; }, [{ path: `${doc}/endings/0/url/0`, kind: 'email' }]),
  make('page title: phone', (d) => { if (d.pages[0]) d.pages[0].title = `Questions? ${PII.phone}`; }, [{ path: `${doc}/pages/0/title`, kind: 'phone_in' }]),
  make('submit label: email', (d) => { d.behavior.submit.label = `Send to ${PII.email2}`; }, [{ path: `${doc}/behavior/submit/label`, kind: 'email' }]),
  make('consent notice: email', (d) => {
    d.blocks[bid('c')] = { ...field('consent', 'c'), config: { mode: 'terms', notice: rich(`Questions: ${PII.email}`), itemiseData: false, items: [{ id: id('i1'), label: inline('I agree'), requiredToSubmit: true, defaultChecked: false }], presentation: 'checkboxes', noticeVersion: 0 } };
    d.pages[0]?.children.push(bid('c'));
  }, [{ path: `${doc}/blocks/c/config/notice/content/0/content/0/text`, kind: 'email' }]),
  make('consent item label: PAN', (d) => {
    d.blocks[bid('c')] = { ...field('consent', 'c'), config: { mode: 'terms', notice: rich('Terms'), itemiseData: false, items: [{ id: id('i1'), label: inline(`I, ${PII.pan}, agree`), requiredToSubmit: true, defaultChecked: false }], presentation: 'checkboxes', noticeVersion: 0 } };
    d.pages[0]?.children.push(bid('c'));
  }, [{ path: `${doc}/blocks/c/config/items/0/label/content/0/content/0/text`, kind: 'pan' }]),
  make('logic literal: phone', (d) => { d.logic.rules = [rule('r1', all('g1', cond('c1', ans('q1'), 'eq', { kind: 'literal', value: { type: 'text', value: PII.phone4 } })), [{ type: 'hide', targets: [bid('q2')] }])]; }, [{ path: `${doc}/logic/rules/0/when/children/0/right/value/value`, kind: 'phone_in' }]),
  make('block_submit message: Aadhaar', (d) => { d.logic.rules = [rule('r1', all('g1'), [{ type: 'block_submit', message: `Not for ${PII.aadhaar}` }])]; }, [{ path: `${doc}/logic/rules/0/then/0/message`, kind: 'aadhaar' }]),
  make('purpose description: email', (d) => { const p = d.privacy.purposes[0]; if (p) p.description = inline(`Contact ${PII.email}`); }, [{ path: `${doc}/privacy/purposes/0/description/content/0/content/0/text`, kind: 'email' }]),
  make('purpose recipients: email', (d) => { const p = d.privacy.purposes[0]; if (p) p.recipients = [PII.email2]; }, [{ path: `${doc}/privacy/purposes/0/recipients/0`, kind: 'email' }]),
  make('translation: phone', (d) => {
    d.i18n.messages[id<S.Locale>('hi-IN')] = { 'block:q1:label': { value: inline(`फ़ोन ${PII.phone}`), sourceHash: id('0'.repeat(64)), origin: 'human' } };
  }, [{ path: `${doc}/i18n/messages/hi-IN/block:q1:label/value/content/0/content/0/text`, kind: 'phone_in' }]),
  make('notification body: PAN', () => {}, [{ path: '/refs/emails/0/body/content/0/content/0/text', kind: 'pan' }],
    ops({ notifications: [notification({ body: { type: 'email_doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `PAN ${PII.pan}` }] }] } })] })),
  make('notification subject: Aadhaar', () => {}, [{ path: '/refs/emails/0/subject/1', kind: 'aadhaar' }], ops({ notifications: [notification({ subject: ['Re: ', PII.aadhaar2] })] })),
  make('notification literal recipient', () => {}, [{ path: '/refs/emails/0/defaultRecipients/0', kind: 'email' }],
    ops({ notifications: [notification({ to: [{ kind: 'email', address: id(PII.email) }] })] })),
  make('notification literal reply-to', () => {}, [{ path: '/refs/emails/0/replyTo', kind: 'email' }],
    ops({ notifications: [notification({ replyTo: { kind: 'email', address: id(PII.email2) } })] })),
  make('route_email action literal recipient', (d) => {
    d.logic.rules = [rule('r1', all('g1'), [{ type: 'route_email', notificationId: id('n1'), field: 'to', mode: 'add', recipients: [{ kind: 'email', address: id(PII.email) }] }])];
  }, [{ path: `${doc}/logic/rules/0/then/0/recipients/0`, kind: 'email' }]),
  make('PDF header: GSTIN', () => {}, [{ path: '/refs/pdf/0/layout/header/content/0/content/0/text', kind: 'gstin' }], ops({ pdfTemplates: [pdfTemplate({ header: rich(`GSTIN ${PII.gstin}`) })] })),
  make('PDF watermark: phone', () => {}, [{ path: '/refs/pdf/0/layout/watermark/0', kind: 'phone_in' }], ops({ pdfTemplates: [pdfTemplate({ watermark: [`Call ${PII.phone3}`] })] })),
  make('closed screen: email', () => {}, [{ path: '/refs/endings/0/content/content/0/content/0/text', kind: 'email' }], ops({ screens: { closed: { content: rich(`Mail ${PII.email}`) } } })),
  make('welcome screen: PAN', (d) => { d.welcome = { enabled: true, content: rich(`Applicant ${PII.pan}`) }; }, [{ path: `${doc}/welcome/content/content/0/content/0/text`, kind: 'pan' }]),
  make('form description: Aadhaar', (d) => { d.description = rich(`Ref ${PII.aadhaar2}`); }, [{ path: `${doc}/description/content/0/content/0/text`, kind: 'aadhaar' }]),
  make('builder note: email', (d) => { block<'short_text'>(d, 'q1').note = `Ask ${PII.email} first`; }, [{ path: `${doc}/blocks/q1/note`, kind: 'email' }]),
  make('long text default: dashed phone', (d) => {
    d.blocks[bid('lt')] = field('long_text', 'lt', { config: { defaultValue: { kind: 'static', value: `Mobile ${PII.phone3}` } } });
    d.pages[0]?.children.push(bid('lt'));
  }, [{ path: `${doc}/blocks/lt/config/defaultValue/value`, kind: 'phone_in' }]),
  make('link href: email', (d) => {
    d.blocks[bid('para')] = { id: bid('para'), type: 'paragraph', config: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Write to us', marks: [{ type: 'link', attrs: { href: id(`mailto:${PII.email2}`) } }] }] }] } } };
    d.pages[0]?.children.push(bid('para'));
  }, [{ path: `${doc}/blocks/para/config/content/content/0/content/0/marks/0/attrs/href`, kind: 'email' }]),
  make('extension payload: email and PAN', (d) => {
    block<'short_text'>(d, 'q1').x = { 'x-crm': { owner: PII.email, ids: [{ pan: PII.pan }] } };
  }, [{ path: `${doc}/blocks/q1/x/x-crm/owner`, kind: 'email' }, { path: `${doc}/blocks/q1/x/x-crm/ids/0/pan`, kind: 'pan' }]),
  make('unsupported block raw payload: bare 91 phone', (d) => {
    d.blocks[bid('legacy')] = { id: bid('legacy'), type: 'unsupported', originalType: 'whatsapp_button', raw: { label: 'Chat with us', href: 'https://wa.me/919876543210' } };
    d.pages[0]?.children.push(bid('legacy'));
  }, [{ path: `${doc}/blocks/legacy/raw/href`, kind: 'phone_in' }]),
  make('several in one string', (d) => { block<'short_text'>(d, 'q1').config.placeholder = `${PII.email} / ${PII.phone} / ${PII.gstin}`; }, [
    { path: `${doc}/blocks/q1/config/placeholder`, kind: 'email' },
    { path: `${doc}/blocks/q1/config/placeholder`, kind: 'gstin' },
    { path: `${doc}/blocks/q1/config/placeholder`, kind: 'phone_in' },
  ]),
];

/** Look-alikes that are not PII: none of these may be reported. */
export const NOT_PII = [
  `${aadhaar('23456789012').slice(0, 11)}${(Number(aadhaar('23456789012').slice(11)) + 1) % 10}`,
  '12345678901',
  '1234 5678 9012',
  'ABCDE1234',
  'INV-2026-000123',
  '2026-10-18',
  '₹4,999.00',
  'Room 5551234',
  'user@localhost',
  'ABCXK1234F',
  '+1 415 555 0100',
] as const;
