import { describe, expect, it } from 'vitest';
import * as S from '../src/index.ts';
import { V1_FIXTURES } from './fixtures/v1/index.ts';
import { migrationContext, seededIds } from './fixtures/migration.ts';
import { REGISTRY_STANDIN } from './fixtures/registry-standin.ts';

/*
 * WP-0.05: v1 → v2 over the corpus (5 templates + 30 bug fixtures), with the registry stand-in (registry-en-IN.json,
 * kept equal to @form/registry by @form/logic's test/migrate.test.ts, which also runs validateDefinition and compile).
 */

const wire = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));
const ctx = (seed = 'm') => migrationContext(REGISTRY_STANDIN, seed);

function parsed(doc: unknown): S.V1.FormSchema {
  const result = S.parseV1(doc);
  if (!result.success) throw new Error(result.error);
  return result.data;
}
const fixture = (name: string): S.V1.FormSchema => parsed(V1_FIXTURES.find((f) => f.name === name)?.doc);
const migrated = (name: string) => S.migrateV1ToV2(fixture(name), ctx());
const block = (result: S.V1MigrationResult, id: string) => result.definition.blocks[id as S.BlockId];
const codes = (result: S.V1MigrationResult) => result.notes.map((n) => n.code);

/** Note codes each fixture must produce, besides the ones every form gets (keys, default compliance and purpose). */
const EVERY_FORM: ReadonlySet<S.MigrationNote['code']> = new Set(['key_generated', 'compliance_defaulted', 'default_purpose_added']);
const EXPECTED_NOTES: Readonly<Record<string, ReadonlyArray<S.MigrationNote['code']>>> = {
  'template-contact': [],
  'template-event': [],
  'template-feedback': [],
  'template-job': [],
  'template-nps': [],
  'b01-paging-later-page': ['logic_rule_disabled', 'initially_hidden_set'],
  'b02-hidden-required': ['initially_hidden_set'],
  'b03-hidden-answer-kept': [],
  'b04-blank-signature': ['initially_hidden_set'],
  'b05-signature-styles': ['clamped'],
  'b06-signature-half-width': [],
  'b07-unanswered-scales': ['clamped', 'initially_hidden_set'],
  'b08-ranking-required': ['initially_hidden_set'],
  'b09-optional-choice': ['initially_hidden_set'],
  'b10-trailing-thank-you-page': ['logic_rule_disabled', 'empty_trailing_page_removed'],
  'b11-success-message-html': ['html_sanitised'],
  'b12-invalid-regex': ['unsafe_pattern_dropped'],
  'b13-email-pattern-ignored': ['unsafe_pattern_dropped', 'initially_hidden_set'],
  'b14-required-number': ['clamped', 'logic_operator_changed', 'initially_hidden_set'],
  'b15-option-values': ['logic_operator_changed', 'initially_hidden_set', 'logic_value_unmatched'],
  'b16-duplicate-option-values': ['duplicate_option_value', 'logic_operator_changed', 'initially_hidden_set'],
  'b20-duplicated-blocks': ['initially_hidden_set', 'logic_rule_disabled'],
  'b21-dangling-logic': ['dangling_logic_source'],
  'b23-demo-id': ['key_generated', 'initially_hidden_set'],
  'b25-choice-displays': ['initially_hidden_set'],
  'b26-hidden-fields': ['clamped', 'initially_hidden_set'],
  'b27-disabled-required': ['required_disabled_resolved'],
  'b28-rating-max': ['clamped', 'initially_hidden_set', 'logic_value_unmatched'],
  's01-label-xss': ['html_sanitised'],
  's02-paragraph-xss': ['html_sanitised'],
  's03-escaped-text': [],
  's04-javascript-links': ['html_sanitised'],
  's05-password-closed': ['password_extracted'],
  's06-unsafe-redirect': ['logic_rule_disabled', 'redirect_dropped'],
  's07-external-assets': ['initially_hidden_set', 'external_asset_queued'],
};

describe('v1 → v2 over the fixture corpus', () => {
  it('has 35 forms (5 templates, 30 bug fixtures) that parseV1 reads without repairs', () => {
    expect(V1_FIXTURES).toHaveLength(35);
    expect(Object.keys(EXPECTED_NOTES).sort()).toEqual(V1_FIXTURES.map((f) => f.name).sort());
    for (const { name, doc } of V1_FIXTURES) expect(S.parseV1(doc), name).toMatchObject({ success: true, repairs: [] });
  });

  it.each(V1_FIXTURES)('$name: golden output (seeded idFactory)', async ({ name, doc }) => {
    const result = S.migrateV1ToV2(parsed(doc), ctx());
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./fixtures/v2/${name}.json`);
  });

  it.each(V1_FIXTURES)('$name: parses, is structurally valid, deterministic and idempotent, with the expected notes', ({ name, doc }) => {
    const input = parsed(doc);
    const before = JSON.stringify(input);
    const result = S.migrateV1ToV2(input, ctx());
    expect(JSON.stringify(input)).toBe(before);
    const checked = S.V1MigrationResultSchema.safeParse(wire(result));
    expect(checked.success ? [] : checked.error.issues).toEqual([]);
    expect(S.validateStructure(result.definition, { mode: 'save' }).filter((i) => i.severity === 'error')).toEqual([]);
    expect(S.migrateV1ToV2(parsed(doc), ctx())).toEqual(result);
    expect(S.migrate(result.definition, ctx('again'))).toEqual({ definition: result.definition, notes: [] });
    const step = S.V1_TO_V2.migrate(parsed(doc), ctx());
    expect(step.notes.map((n) => [n.code, n.path])).toEqual(result.notes.map((n) => [n.code, n.path]));
    expect(S.migrateUnknown(wire(doc), ctx())).toEqual({ definition: result.definition, notes: step.notes });
    /* Another idFactory changes the generated ids and nothing else. */
    const other = JSON.stringify(S.migrateV1ToV2(parsed(doc), ctx('q'))).replace(/\bq_(\d+)\b/g, 'm_$1');
    expect(JSON.parse(other)).toEqual(result);
    const expected = new Set(EXPECTED_NOTES[name]);
    expect(new Set(codes(result).filter((c) => !EVERY_FORM.has(c) || expected.has(c)))).toEqual(expected);
    for (const note of result.notes) expect(note.detail, note.code).not.toBe('');
  });

  it('never carries a script, an event handler or an unsafe URL into the definition (S1–S4, S6, S7)', () => {
    for (const { name, doc } of V1_FIXTURES) {
      const json = JSON.stringify(S.migrateV1ToV2(parsed(doc), ctx()).definition);
      expect(json, name).not.toMatch(/<script|onerror|onclick|onmouseover|javascript:|data:|<iframe|<object/i);
    }
  });
});

describe('v1 → v2 mapping', () => {
  it('turns the builder templates into v2 forms with keys, compliance and the default purpose', () => {
    const result = migrated('template-contact');
    const def = result.definition;
    expect(def.formId).toBe('tpl_contact');
    expect(def.title).toBe('Contact us');
    expect(def.description).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'We usually reply within one business day.' }] }] });
    expect(def.pages).toHaveLength(1);
    expect(def.pages[0]?.children).toEqual(['tpl_contact_b1', 'tpl_contact_b2', 'tpl_contact_b3', 'tpl_contact_b4', 'tpl_contact_b5']);
    expect(block(result, 'tpl_contact_b1')).toMatchObject({ type: 'heading', config: { level: 1 } });
    expect(block(result, 'tpl_contact_b3')).toMatchObject({ type: 'short_text', key: 'full_name', required: false, config: { placeholder: 'Enter short answer' } });
    expect(block(result, 'tpl_contact_b4')).toMatchObject({ type: 'email', key: 'email', compliance: { classification: 'personal', principalIdentifier: 'email', purposeIds: [def.privacy.purposes[0]?.id] } });
    expect(def.privacy.purposes).toEqual([expect.objectContaining({ name: 'Respond to this form', lawfulBasis: expect.objectContaining({ kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose' }), retention: { kind: 'org_default' } })]);
    expect(def.privacy.fiduciary.legalName).toEqual([{ var: { name: 'org.legal_name' } }]);
    expect(def.endings).toEqual([expect.objectContaining({ kind: 'message', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Thanks — we received your response.' }] }] }, confetti: true })]);
    expect(def.defaultEndingId).toBe(def.endings[0]?.id);
    expect(result.ops).toEqual({
      access: { enabled: true, uniqueSubmission: 'off', embedAllowlist: [], screens: { closed: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'This form is no longer accepting responses.' }] }] } } } },
      retention: { basis: 'submitted_at', onExpiry: 'delete', files: 'with_submission', draftsDays: 30, trashDays: 30 },
    });
    expect(block(migrated('template-job'), 'tpl_job_b4')).toMatchObject({ type: 'single_choice', config: { display: 'dropdown', options: [{ id: 'tpl_job_b4_o1', label: 'Option 1', code: 'option_1' }, expect.anything(), expect.anything()] } });
  });

  it('splits pages at page breaks, keeps the break ids and drops a trailing page without a question (B1, B10)', () => {
    const paging = migrated('b01-paging-later-page').definition;
    expect(paging.pages.map((p) => [p.id, p.title ?? null, p.children.length])).toEqual([['m_1', null, 4], ['b01_p2', null, 3], ['b01_p3', 'About you', 2]]);
    expect(block(migrated('b01-paging-later-page'), 'b01_about')).toMatchObject({ required: true });
    const trailing = migrated('b10-trailing-thank-you-page');
    expect(trailing.definition.pages.map((p) => p.children)).toEqual([['b10_name', 'b10_email']]);
    expect(trailing.definition.endings.map((e) => [e.id, e.kind])).toEqual([['b10_thanks', 'message'], ['m_2', 'redirect']]);
    expect(trailing.definition.defaultEndingId).toBe('m_2');
    expect(trailing.definition.endings[1]).toMatchObject({ url: ['https://example.com/thanks'], message: trailing.definition.endings[0]?.kind === 'message' ? trailing.definition.endings[0].content : null });
  });

  it('keeps v1 show/hide as one rule per block, with initiallyHidden for show (B2, B3)', () => {
    const result = migrated('b02-hidden-required');
    const [show, hide] = result.definition.logic.rules;
    expect(show).toMatchObject({ enabled: true, when: { combinator: 'all', children: [{ op: 'eq', left: { ref: { blockId: 'b02_student' } }, right: { kind: 'options', optionIds: ['b02_student_o1'] } }] }, then: [{ type: 'show', targets: ['b02_school'] }] });
    expect(hide).toMatchObject({ enabled: true, then: [{ type: 'hide', targets: ['b02_employer'] }] });
    expect(block(result, 'b02_school')).toMatchObject({ initiallyHidden: true, required: true });
    expect(block(result, 'b02_employer')).not.toHaveProperty('initiallyHidden');
    const kept = migrated('b03-hidden-answer-kept');
    expect(kept.definition.logic.rules.map((r) => r.when.children.map((c) => (c.kind === 'condition' ? c.op : 'group')))).toEqual([['is_not_answered'], ['contains']]);
    expect(block(kept, 'b03_coupon')).toMatchObject({ config: { defaultValue: { kind: 'static', value: 'WELCOME10' } } });
  });

  it('disables rules v2 cannot keep: later pages (I8), cycles, deleted sources (B21) and unmatched values', () => {
    const later = migrated('b01-paging-later-page').definition.logic.rules[0];
    expect(later).toMatchObject({ enabled: false, when: { children: [{ op: 'gt', right: { kind: 'literal', value: { type: 'number', value: '18' } } }] } });
    const cycles = migrated('b20-duplicated-blocks').definition.logic.rules;
    expect(cycles.map((r) => [r.then[0]?.type === 'show' || r.then[0]?.type === 'hide' ? r.then[0].targets[0] : null, r.enabled])).toEqual([
      ['b20_copy_a', true], ['b20_copy_b', true], ['b20_loop_a', true], ['b20_loop_b', false], ['b20_self', false],
    ]);
    const dangling = migrated('b21-dangling-logic');
    expect(dangling.definition.logic.rules.map((r) => r.enabled)).toEqual([false, false, false]);
    expect(dangling.notes.filter((n) => n.code === 'dangling_logic_source').map((n) => n.path)).toEqual(['/logic/rules/0', '/logic/rules/1', '/logic/rules/2', '/blocks/5/logic']);
    expect(block(dangling, 'b21_gone_show')).not.toHaveProperty('initiallyHidden');
    const unmatched = migrated('b15-option-values');
    expect(unmatched.definition.logic.rules.map((r) => r.enabled)).toEqual([true, false, true]);
    expect(unmatched.definition.logic.rules[0]?.when.children[0]).toMatchObject({ right: { kind: 'options', optionIds: ['b15_plan_o3'] } });
  });

  it('matches duplicate option values the way v1 compared them (B15, B16)', () => {
    const result = migrated('b16-duplicate-option-values');
    const [size, gift, card] = result.definition.logic.rules;
    expect(size?.when.children).toMatchObject([{ op: 'includes_any', right: { optionIds: ['b16_size_o3', 'b16_size_o4'] } }]);
    expect(gift?.when).toMatchObject({ combinator: 'all', children: [{ op: 'includes_any' }, { op: 'count_eq', right: { value: { type: 'number', value: '1' } } }] });
    expect(gift?.when).not.toHaveProperty('negate');
    expect(card?.when).toMatchObject({ negate: true, children: [{ op: 'includes_any' }, { op: 'count_eq' }] });
    expect(block(result, 'b16_size')).toMatchObject({ config: { options: [{ code: 'small' }, { code: 'medium' }, { code: 'large', label: 'L' }, { code: 'large', label: 'XL' }] } });
  });

  it('maps every v1 operator it can keep, with typed values', () => {
    const condition = (name: string, i: number) => migrated(name).definition.logic.rules[i]?.when.children[0];
    expect(condition('b07-unanswered-scales', 0)).toMatchObject({ op: 'lt', right: { value: { type: 'number', value: '7' } } });
    expect(condition('b13-email-pattern-ignored', 0)).toMatchObject({ op: 'contains', right: { value: { type: 'text', value: 'acme' } } });
    expect(condition('b14-required-number', 1)).toMatchObject({ op: 'eq', right: { value: { type: 'number', value: '0' } } });
    expect(condition('b26-hidden-fields', 0)).toMatchObject({ op: 'eq', caseSensitive: true, right: { value: { type: 'text', value: 'newsletter' } } });
    expect(condition('s07-external-assets', 0)).toMatchObject({ op: 'after', right: { value: { type: 'time', value: '18:00' } } });
    expect(condition('s07-external-assets', 1)).toMatchObject({ op: 'before', right: { value: { type: 'date', value: '2026-12-01' } } });
    expect(condition('b09-optional-choice', 2)).toMatchObject({ op: 'is_not_answered' });
    expect(condition('b15-option-values', 2)).toMatchObject({ op: 'neq', right: { kind: 'options', optionIds: ['b15_plan_o1'] } });
  });

  it('keeps patterns only when they are safe short-text patterns (B12, B13, S8)', () => {
    const result = migrated('b12-invalid-regex');
    expect(block(result, 'b12_code')).toMatchObject({ required: true, messages: { required: 'Use the code from your letter' } });
    expect(block(result, 'b12_code')).not.toHaveProperty('config.pattern');
    expect(block(result, 'b12_pin')).toMatchObject({ config: { pattern: { source: '^[0-9]{6}$' }, minLength: 6, maxLength: 6 }, messages: { too_short: 'Six digits', too_long: 'Six digits', pattern: 'Six digits' } });
    expect(block(result, 'b12_bio')).toMatchObject({ type: 'long_text', config: { limit: { unit: 'characters', max: 500 } } });
    const email = migrated('b13-email-pattern-ignored');
    expect(block(email, 'b13_work')).toMatchObject({ messages: { required: 'Use your work email', invalid_email: 'Use your work email' } });
    expect(block(email, 'b13_site')).toMatchObject({ messages: { invalid_url: 'A full https:// link, please' } });
  });

  it('turns number limits into decimals and drops impossible ones (B14)', () => {
    const result = migrated('b14-required-number');
    expect(block(result, 'b14_qty')).toMatchObject({ required: true, config: { min: '1', max: '10', defaultValue: '2', prefix: 'Qty' }, messages: { required: 'Between 1 and 10', below_min: 'Between 1 and 10', above_max: 'Between 1 and 10' } });
    expect(block(result, 'b14_budget')).toMatchObject({ config: { display: 'input' } });
    expect(block(result, 'b14_budget')).not.toHaveProperty('config.min');
  });

  it('maps choice displays to one answer shape each (B9, B25)', () => {
    const result = migrated('b25-choice-displays');
    expect(block(result, 'b25_langs')).toMatchObject({ type: 'multi_choice', config: { display: 'dropdown' } });
    expect(block(result, 'b25_tools')).toMatchObject({ type: 'multi_choice', config: { display: 'checkbox' } });
    expect(block(result, 'b25_how')).toMatchObject({ type: 'single_choice', config: { display: 'radio', other: { enabled: true, label: 'Other', textRequired: false }, shuffle: { keepLast: 0 } } });
    expect(block(result, 'b25_city')).toMatchObject({ type: 'single_choice', config: { display: 'dropdown', placeholder: 'Pick a city', defaultOptionId: 'b25_city_o1' } });
    expect(block(migrated('b09-optional-choice'), 'b09_pref')).toMatchObject({ required: false, config: { display: 'radio' } });
  });

  it('gives hidden fields a URL-parameter source, keyed by their label, with the label as the builder note (B26)', () => {
    const result = migrated('b26-hidden-fields');
    expect(block(result, 'b26_utm')).toMatchObject({ type: 'hidden', key: 'utm_source', note: 'UTM source', required: false, config: { source: { kind: 'url_param' } } });
    expect(block(result, 'b26_campaign')).toMatchObject({ key: 'campaign_id', note: 'Campaign id', required: false });
  });

  it('makes disabled fields read-only and never required (B27)', () => {
    const result = migrated('b27-disabled-required');
    expect(block(result, 'b27_member')).toMatchObject({ readOnly: true, required: false, config: { defaultValue: { kind: 'static', value: 'M-001' } } });
    expect(block(result, 'b27_contact')).toMatchObject({ readOnly: true, required: false, autoFocus: true, hideLabel: true });
    expect(block(result, 'b27_notes')).toMatchObject({ required: true });
    expect(block(result, 'b27_notes')).not.toHaveProperty('readOnly');
  });

  it('clamps ratings and scales to the v2 ranges (B7, B28)', () => {
    const result = migrated('b28-rating-max');
    expect(block(result, 'b28_stars')).toMatchObject({ config: { max: 10, icon: 'star', defaultValue: 3 } });
    expect(block(result, 'b28_tiny')).toMatchObject({ config: { max: 1 } });
    expect(block(result, 'b28_scale')).toMatchObject({ config: { min: 0, max: 4 } });
    expect(block(result, 'b28_wide')).toMatchObject({ config: { min: 1, max: 10 } });
    const scales = migrated('b07-unanswered-scales');
    /* The v1 builder drew scaleMin..scaleMax with no cap (BL-109): 0–10 stays 0–10, and 1–50 is clamped with a note. */
    expect(block(scales, 'b07_ease')).toMatchObject({ config: { min: 0, max: 10, lowLabel: 'Hard', highLabel: 'Easy' } });
    expect(scales.notes.filter((n) => n.path.startsWith('/blocks/b07_ease/config'))).toEqual([]);
    expect(result.notes.find((n) => n.path === '/blocks/b28_wide/config/max')).toMatchObject({ code: 'clamped', detail: expect.stringContaining('50 is now 10') });
    expect(block(scales, 'b07_score')).toMatchObject({ type: 'nps', config: {} });
  });

  it('carries styles and half-width layout (B5, B6)', () => {
    const styled = block(migrated('b05-signature-styles'), 'b05_sign');
    expect(styled).toMatchObject({ style: { labelColor: '#cc0000', labelSizePx: 48, inputSizePx: 10, labelWeight: 'bold', align: 'center', inputBg: '#ffffffcc' } });
    expect(styled).not.toHaveProperty('style.placeholderColor');
    expect(styled).toMatchObject({ description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use your finger or a mouse' }] }] } });
    const row = migrated('b06-signature-half-width');
    expect(['b06_first', 'b06_last', 'b06_sign', 'b06_rule'].map((id) => (block(row, id) as { layout?: unknown } | undefined)?.layout ?? null)).toEqual([
      { width: 'half', startNewRow: true }, { width: 'half' }, { width: 'half', startNewRow: true }, null,
    ]);
  });

  it('keeps valid v1 ids and generates the invalid ones (B20, B23)', () => {
    const demo = migrated('b23-demo-id');
    expect(demo.definition.formId).toBe('demo');
    expect(Object.keys(demo.definition.blocks)).toEqual(['m_1', 'b23_needs', 'b23_choice']);
    expect(demo.notes.find((n) => n.path === '/blocks/0/id')).toMatchObject({ code: 'key_generated', detail: expect.stringContaining("'m_1'") });
    expect(demo.definition.logic.rules[0]?.when.children[0]).toMatchObject({ left: { ref: { blockId: 'm_1' } } });
    const dup = migrated('b20-duplicated-blocks');
    expect(block(dup, 'b20_pick_copy')).toMatchObject({ key: 'pick_one_2', config: { options: [{ id: 'b20_pick_o1' }, { id: 'b20_pick_o2' }] } });
  });

  it('sanitises v1 HTML into the rich-text AST and keeps plain text as text (S1–S4, B11)', () => {
    const labels = migrated('s01-label-xss');
    expect(block(labels, 's01_title')).toMatchObject({ type: 'heading', config: { level: 2, text: { content: [{ content: [{ type: 'text', text: 'Welcome', marks: [{ type: 'bold' }] }] }] } } });
    expect(block(labels, 's01_name')).toMatchObject({ key: 'name', label: { content: [{ content: [{ type: 'text', text: 'Name' }] }] } });
    expect(block(labels, 's01_email')).toMatchObject({ key: 'email', label: { content: [{ content: [{ text: 'Email', marks: [{ type: 'textColor', attrs: { color: '#dd0000' } }] }] }] } });
    const links = migrated('s04-javascript-links');
    const help = block(links, 's04_help');
    expect(JSON.stringify(help)).toContain('"href":"https://example.com/help"');
    expect(JSON.stringify(help)).toContain('"href":"mailto:help@example.com"');
    const escaped = migrated('s03-escaped-text');
    expect(escaped.definition.title).toBe('Q&A <draft>');
    expect(block(escaped, 's03_names')).toMatchObject({ label: { content: [{ content: [{ type: 'text', text: 'Tom & Jerry <3' }] }] } });
    expect(block(escaped, 's03_pick')).toMatchObject({ config: { options: [{ label: '<b>not bold</b>' }, { label: 'Fish & chips' }] } });
    expect(S.toPlain((block(escaped, 's03_long') as S.PlainBlockOf<'paragraph'>).config.content)).toBe('a&'.repeat(12_000));
    const success = migrated('b11-success-message-html').definition.endings[0];
    expect(success).toMatchObject({ kind: 'message', confetti: false, content: { content: [{ content: [{ text: 'Thanks!', marks: [{ type: 'bold' }] }, { text: ' We will reply soon.' }] }] } });
  });

  it('returns the password only for hashing (S5) and moves the closed state to ops', () => {
    const result = migrated('s05-password-closed');
    expect(result.plaintextPasswordToHash).toBe('hunter2');
    expect(JSON.stringify({ definition: result.definition, ops: result.ops, notes: result.notes })).not.toContain('hunter2');
    expect(result.ops.access).toMatchObject({ enabled: false, screens: { closed: { content: { content: [{ content: [{ text: 'Registrations are closed.' }, { type: 'hardBreak' }, { text: 'See you next year.' }] }] } } } });
    expect(S.migrate(fixture('s05-password-closed'), ctx()).notes.map((n) => n.code)).toContain('password_extracted');
    expect(migrated('template-contact')).not.toHaveProperty('plaintextPasswordToHash');
  });

  it('drops redirects that are not https and logic on thank-you screens (S6)', () => {
    const result = migrated('s06-unsafe-redirect');
    expect(result.definition.endings.map((e) => [e.id, e.kind, e.name])).toEqual([['s06_thanks', 'message', 'Thank you!'], ['s06_thanks_vip', 'message', 'Thank you']]);
    expect(result.definition.endings[1]).toMatchObject({ content: { content: [{ content: [{ text: 'Thanks for your response!' }] }] } });
    expect(result.definition.logic.rules).toEqual([]);
    const http = S.migrateV1ToV2({ ...fixture('s06-unsafe-redirect'), settings: { ...fixture('s06-unsafe-redirect').settings, redirectUrl: 'http://example.com' } }, ctx());
    expect(http.definition.endings.every((e) => e.kind === 'message')).toBe(true);
    expect(codes(http)).toContain('redirect_dropped');
  });

  it('queues external images for import and maps the theme (S7)', () => {
    const result = migrated('s07-external-assets');
    expect(result.assetImports).toEqual([{ target: 'logo', url: 'https://cdn.example.com/logo.png' }]);
    expect(result.notes.filter((n) => n.code === 'external_asset_queued').map((n) => n.path)).toEqual(['/settings/logoUrl', '/settings/coverUrl']);
    expect(result.definition.theme.tokens).toMatchObject({ colors: { page: '#FFFFFF', text: '#111111', inputText: '#111111' }, typography: { body: 'georgia' }, progress: 'bar' });
    expect(result.definition.theme.tokens.colors).not.toHaveProperty('accent');
    expect(result.definition.behavior.submit.label).toBe('Send it');
    expect(block(result, 's07_cv')).toMatchObject({ config: { maxFiles: 20 } });
    expect(block(result, 's07_when')).toMatchObject({ config: { pattern: 'DD-MM-YYYY', defaultValue: { kind: 'fixed', date: '2026-11-01' } } });
    expect(block(result, 's07_time')).toMatchObject({ config: { defaultValue: { kind: 'fixed', time: '09:30' } } });
  });
});

describe('v1 → v2 edge cases', () => {
  const base = (): S.V1.FormSchema => ({ id: 'f1', title: 'T', description: '', blocks: [], settings: { ...S.V1.DEFAULT_SETTINGS } });
  const text = (id: string, label: string, order: number, extra: Partial<S.V1.FormBlock> = {}): S.V1.FormBlock => ({ id, type: 'text', label, order, ...extra });

  it('migrates an empty form to one empty page and one ending', () => {
    const result = S.migrateV1ToV2(base(), ctx());
    expect(result.definition.pages).toEqual([{ id: 'm_1', children: [] }]);
    expect(result.definition.endings).toHaveLength(1);
    expect(codes(result)).toEqual(['default_purpose_added']);
    expect(S.validateStructure(result.definition).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('sorts by order, removes empty pages and moves trailing content to the last page with a question', () => {
    const form: S.V1.FormSchema = {
      ...base(),
      blocks: [
        text('b', 'Second', 2), { id: 'br1', type: 'page_break', label: '', order: 0 }, text('a', 'First', 1),
        { id: 'br2', type: 'page_break', label: '', order: 3 }, { id: 'br3', type: 'page_break', label: '', order: 4 },
        { id: 'outro', type: 'paragraph', label: 'Bye', order: 5 },
      ],
    };
    const result = S.migrateV1ToV2(form, ctx());
    expect(result.definition.pages).toEqual([{ id: 'br1', children: ['a', 'b', 'outro'] }]);
    expect(result.notes.filter((n) => n.code === 'empty_trailing_page_removed').map((n) => n.path)).toEqual(['/blocks/4', '/blocks/3']);
  });

  it('de-duplicates keys and falls back to the type name', () => {
    const form: S.V1.FormSchema = {
      ...base(),
      blocks: [text('a', 'Name', 0), text('b', 'Name', 1), text('c', '<b></b>', 2), text('d', '123 go', 3), text('e', 'constructor', 4), text('f', 'Ünïcödé façade', 5), text('g', 'x'.repeat(80), 6), text('h', 'x'.repeat(80), 7)],
    };
    const keys = Object.values(S.migrateV1ToV2(form, ctx()).definition.blocks).map((b) => (b && 'key' in b ? b.key : null));
    expect(keys).toEqual(['name', 'name_2', 'short_text', 'f_123_go', 'constructor_2', 'unicode_facade', 'x'.repeat(64), `${'x'.repeat(62)}_2`]);
  });

  it('turns empty v1 values into the exact v2 operators', () => {
    const logic = (operator: S.V1.LogicOperator, value: string): NonNullable<S.V1.FormBlock['logic']> => ({ enabled: true, action: 'show', sourceBlockId: 'src', operator, value });
    const form: S.V1.FormSchema = {
      ...base(),
      blocks: [
        text('src', 'Source', 0),
        text('t1', 'A', 1, { logic: logic('equals', '') }),
        text('t2', 'B', 2, { logic: logic('not_equals', '') }),
        text('t3', 'C', 3, { logic: logic('contains', '') }),
        text('t4', 'D', 4, { logic: logic('not_contains', '') }),
        text('t5', 'E', 5, { logic: logic('greater_than', 'a') }),
        { id: 'num', type: 'number', label: 'N', order: 6 },
        text('t6', 'F', 7, { logic: { ...logic('greater_than', ''), sourceBlockId: 'num' } }),
        text('t7', 'G', 8, { logic: { ...logic('equals', ' 05.50 '), sourceBlockId: 'num' } }),
        text('t8', 'H', 9, { logic: { ...logic('equals', 'abc'), sourceBlockId: 'num' } }),
        { id: 'sig', type: 'signature', label: 'S', order: 10 },
        text('t9', 'I', 11, { logic: { ...logic('equals', 'x'), sourceBlockId: 'sig' } }),
        { id: 'day', type: 'date', label: 'D', order: 12 },
        text('t10', 'J', 13, { logic: { ...logic('equals', '2026-02-30'), sourceBlockId: 'day' } }),
      ],
    };
    const result = S.migrateV1ToV2(form, ctx());
    const summary = result.definition.logic.rules.map((r) => [r.enabled, r.when.combinator, r.when.children.map((c) => (c.kind === 'condition' ? `${c.op}${c.right?.kind === 'literal' && 'value' in c.right.value ? ` ${String(c.right.value.value)}` : ''}` : 'group'))]);
    expect(summary).toEqual([
      [true, 'all', ['is_not_answered']],
      [true, 'all', ['is_answered']],
      [true, 'all', []],
      [true, 'any', []],
      [false, 'all', ['gt a']],
      [true, 'all', ['gt 0']],
      [true, 'all', ['eq 5.5']],
      [false, 'all', ['eq abc']],
      [false, 'all', ['eq x']],
      [false, 'all', ['eq 2026-02-30']],
    ]);
    expect(result.notes.filter((n) => n.path.startsWith('/logic/')).map((n) => n.code)).toEqual([
      'logic_operator_changed', 'logic_operator_changed', 'logic_operator_changed', 'logic_operator_changed', 'logic_rule_disabled',
      'logic_operator_changed', 'logic_operator_changed', 'logic_value_unmatched', 'logic_rule_disabled', 'logic_value_unmatched',
    ]);
  });

  it('fills a choice field without options and cuts over-long strings, with notes', () => {
    const form: S.V1.FormSchema = {
      ...base(),
      title: 't'.repeat(600),
      blocks: [
        { id: 'c', type: 'dropdown', label: 'Pick', order: 0, options: [], placeholder: 'p'.repeat(300), customize: { prefix: 'x' } },
        { id: 'o', type: 'multiple_choice', label: 'Pick', order: 1, options: [{ id: 'bad id', label: 'A', value: 'a' }, { id: 'o1', label: 'B', value: 'b' }, { id: 'o1', label: 'C', value: 'v'.repeat(250) }] },
        text('m', 'M', 2, { validation: { required: true, errorMessage: 'e'.repeat(1200), min: -3, max: 2.4 }, customize: { prefix: 'p'.repeat(40), defaultValue: 'way too long' } }),
      ],
    };
    const result = S.migrateV1ToV2(form, ctx());
    expect(result.definition.title).toHaveLength(500);
    expect(block(result, 'c')).toMatchObject({ config: { options: [{ id: 'm_4' }, { id: 'm_5' }, { id: 'm_6' }] } });
    expect((block(result, 'c') as S.FieldBlockOf<'single_choice'>).config.placeholder).toHaveLength(200);
    expect(block(result, 'c')).not.toHaveProperty('config.prefix');
    expect((block(result, 'o') as S.FieldBlockOf<'single_choice'>).config.options.map((o) => [o.id, o.code?.length])).toEqual([['m_7', 1], ['o1', 1], ['m_8', 200]]);
    expect(block(result, 'm')).toMatchObject({ config: { minLength: 0, maxLength: 2 } });
    expect((block(result, 'm') as S.FieldBlockOf<'short_text'>).config.prefix).toHaveLength(32);
    expect(block(result, 'm')).not.toHaveProperty('config.defaultValue');
    expect((block(result, 'm') as S.FieldBlockOf<'short_text'>).messages?.required).toHaveLength(1000);
    expect(S.V1MigrationResultSchema.safeParse(wire(result)).success).toBe(true);
  });

  it('notes every default, error message and required flag it drops', () => {
    const opts = [{ id: 'o1', label: 'A', value: 'a' }, { id: 'o2', label: 'B', value: 'b' }];
    const form: S.V1.FormSchema = {
      ...base(),
      blocks: [
        { id: 'm', type: 'checkbox', label: 'M', order: 0, options: opts, customize: { defaultValue: 'a' } },
        { id: 'r', type: 'rating', label: 'R', order: 1, customize: { defaultValue: '2.5' } },
        { id: 'ph', type: 'phone', label: 'P', order: 2, validation: { required: false, errorMessage: 'Bad phone' }, customize: { defaultValue: '+91 98765 43210' } },
        { id: 's', type: 'dropdown', label: 'S', order: 3, options: opts, customize: { defaultValue: 'zzz' } },
        { id: 'd', type: 'date', label: 'D', order: 4, customize: { defaultValue: '2026-02-30' } },
        { id: 'h', type: 'hidden', label: 'H', order: 5, validation: { required: true } },
        { id: 'ok', type: 'dropdown', label: 'OK', order: 6, options: opts, customize: { defaultValue: 'b' } },
      ],
    };
    const result = S.migrateV1ToV2(form, ctx());
    expect(result.notes.filter((n) => n.code === 'clamped').map((n) => [n.path, n.detail])).toEqual([
      ['/blocks/m/config/defaultValue', 'default "a" dropped: v1 never applied it'],
      ['/blocks/r/config/defaultValue', 'default "2.5" dropped: it is not a valid rating value'],
      ['/blocks/ph/config/defaultValue', 'default "+91 98765 43210" dropped: v2 phone fields have no default'],
      ['/blocks/ph/messages', 'the error message has no v2 message code on this phone field; dropped'],
      ['/blocks/s/config/defaultValue', 'default "zzz" dropped: it matches no option'],
      ['/blocks/d/config/defaultValue', 'default "2026-02-30" dropped: it is not a valid date value'],
      ['/blocks/h/required', 'hidden fields are never required (v1 never asked for them); the field is optional'],
    ]);
    expect(block(result, 'ok')).toMatchObject({ config: { defaultOptionId: 'o2' } });
  });

  it('reads an unknown or inherited font name as the default font', () => {
    for (const font of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'Comic Sans']) {
      const result = S.migrateV1ToV2({ ...base(), settings: { ...S.V1.DEFAULT_SETTINGS, font } }, ctx());
      expect(result.definition.theme.tokens.typography.body).toBe('inter');
      expect(S.V1MigrationResultSchema.safeParse(wire(result)).success).toBe(true);
    }
    expect(S.migrateV1ToV2({ ...base(), settings: { ...S.V1.DEFAULT_SETTINGS, font: 'Georgia' } }, ctx()).definition.theme.tokens.typography.body).toBe('georgia');
  });

  it('keeps a 0–10 scale whole, so a rule on its top value stays live (BL-109)', () => {
    const form: S.V1.FormSchema = {
      ...base(),
      blocks: [
        { id: 's', type: 'linear_scale', label: 'S', order: 0, customize: { scaleMin: 0, scaleMax: 10 } },
        text('t', 'T', 1, { logic: { enabled: true, action: 'show', sourceBlockId: 's', operator: 'greater_than', value: '9' } }),
      ],
    };
    const result = S.migrateV1ToV2(form, ctx());
    expect(block(result, 's')).toMatchObject({ config: { min: 0, max: 10 } });
    expect(result.definition.logic.rules.map((r) => r.enabled)).toEqual([true]);
    expect(codes(result)).not.toContain('clamped');
    expect(codes(result)).not.toContain('logic_value_unmatched');
  });

  it('never gives the source id of a deleted rule source to another block (BL-110)', () => {
    const form: S.V1.FormSchema = {
      ...base(),
      blocks: [
        text('bad id', 'Renamed', 0),
        text('t', 'T', 1, { logic: { enabled: true, action: 'show', sourceBlockId: 'm_1', operator: 'equals', value: 'x' } }),
      ],
    };
    const result = S.migrateV1ToV2(form, ctx());
    expect(Object.keys(result.definition.blocks)).not.toContain('m_1');
    const [rule] = result.definition.logic.rules;
    expect(rule).toMatchObject({ enabled: false, when: { children: [{ left: { ref: { blockId: 'm_1' } } }] } });
    expect(result.notes.find((n) => n.code === 'dangling_logic_source')?.detail).toContain("'m_1' was deleted");
  });

  it('never generates an id that a kept v1 option id uses (seeded idFactory)', () => {
    const form: S.V1.FormSchema = {
      ...base(),
      blocks: [
        { id: 'c', type: 'dropdown', label: 'C', order: 0, options: [{ id: 'm_4', label: 'A', value: 'a' }, { id: 'bad id', label: 'B', value: 'b' }] },
        { id: 'd', type: 'checkbox', label: 'D', order: 1, options: [{ id: 'x', label: 'X', value: 'x' }, { id: 'm_5', label: 'Y', value: 'y' }] },
      ],
    };
    const result = S.migrateV1ToV2(form, ctx());
    const ids = (id: string) => (block(result, id) as S.FieldBlockOf<'single_choice'>).config.options.map((o) => o.id);
    expect(ids('c')).toEqual(['m_4', 'm_6']);
    expect(ids('d')).toEqual(['x', 'm_5']);
    expect(S.validateStructure(result.definition, { mode: 'save' }).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('disables a rule on a rating or scale only when the new range makes it constant (B28)', () => {
    const result = migrated('b28-rating-max');
    expect(result.definition.logic.rules.map((r) => [r.then[0]?.type === 'show' ? r.then[0].targets[0] : null, r.enabled])).toEqual([
      ['b28_high', true], ['b28_beyond', false], ['b28_top', true], ['b28_negative', false], ['b28_low', true],
    ]);
    expect(result.notes.filter((n) => n.code === 'logic_value_unmatched').map((n) => n.detail)).toEqual([
      "'greater_than' 12 is never true on the migrated range 1–10 (v1 allowed 1–10000000); the rule is disabled",
      "'less_than' 0 is never true on the migrated range 0–4 (v1 allowed -5–4); the rule is disabled",
    ]);
    expect(block(result, 'b28_beyond')).not.toHaveProperty('initiallyHidden');
    /* A rule v1 could never fire either keeps its v1 behaviour. */
    const unchanged = S.migrateV1ToV2({
      ...base(),
      blocks: [
        { id: 'r', type: 'rating', label: 'R', order: 0, customize: { ratingMax: 5 } },
        text('t', 'T', 1, { logic: { enabled: true, action: 'show', sourceBlockId: 'r', operator: 'greater_than', value: '7' } }),
      ],
    }, ctx());
    expect(unchanged.definition.logic.rules.map((r) => r.enabled)).toEqual([true]);
  });

  it('notes number limits, colliding option codes and page titles it changes', () => {
    const form: S.V1.FormSchema = {
      ...base(),
      blocks: [
        { id: 'n', type: 'number', label: 'N', order: 0, validation: { min: 1e-7, max: 5 } },
        { id: 'c', type: 'dropdown', label: 'C', order: 1, options: [{ id: 'o1', label: 'A', value: `${'v'.repeat(200)}a` }, { id: 'o2', label: 'B', value: `${'v'.repeat(200)}b` }] },
        { id: 'br', type: 'page_break', label: 't'.repeat(250), order: 2 },
        text('q', 'Q', 3),
      ],
    };
    const result = S.migrateV1ToV2(form, ctx());
    expect(block(result, 'n')).toMatchObject({ config: { max: '5' } });
    expect(block(result, 'n')).not.toHaveProperty('config.min');
    const notes = result.notes.map((n) => [n.code, n.path]);
    expect(notes).toContainEqual(['clamped', '/blocks/n/config/min']);
    expect(notes).toContainEqual(['duplicate_option_value', '/blocks/c/config/options']);
    expect(notes).toContainEqual(['clamped', '/blocks/2/label']);
    expect(result.definition.pages[1]?.title).toHaveLength(200);
  });

  it('refuses an idFactory that keeps returning invalid or used ids, and documents newer than this build', () => {
    expect(() => S.migrateV1ToV2(base(), { ...ctx(), idFactory: () => 'not valid!' })).toThrow(/idFactory/);
    const def = S.migrateV1ToV2(base(), ctx()).definition;
    expect(() => S.migrate({ ...def, schemaVersion: 3 } as unknown as S.FormDefinition, ctx())).toThrow(/newer/);
    expect(() => S.migrateUnknown({ ...def, schemaVersion: 3 }, ctx())).toThrow(/newer/);
    expect(() => S.migrateUnknown({ ...def, title: 5 }, ctx())).toThrow(/invalid form definition/);
    expect(() => S.migrateUnknown({ title: 'no blocks' }, ctx())).toThrow(/invalid v1 form/);
    expect(S.migrateUnknown(wire(def), ctx())).toEqual({ definition: def, notes: [] });
  });

  it('exposes the steps and what each note means', () => {
    expect(S.FORM_MIGRATIONS.map((s) => [s.from, s.to])).toEqual([[1, 2]]);
    expect(S.V1_TO_V2.migrate(base(), ctx()).doc.schemaVersion).toBe(2);
    const left = (name: string) => S.migrate(fixture(name), ctx()).notes.filter((n) => n.code === 'password_extracted' || n.code === 'external_asset_queued').map((n) => n.detail.endsWith('uses migrateV1ToV2 (schema §4.1)'));
    expect(left('s05-password-closed')).toEqual([true]);
    expect(left('s07-external-assets')).toContain(true);
    expect(Object.keys(S.NOTE_MEANINGS).sort()).toEqual([...S.MigrationNoteSchema.shape.code.options].sort());
    expect(seededIds('x')()).toBe('x_1');
  });
});

describe('migration helpers', () => {
  it('toDecimal reads numbers as v1 Number() did, exactly', () => {
    expect(['5', ' 05.50 ', '-0', '+3', '.5', '1e3', '0x10', '-12.0', '1.12345678901', 'abc', '', 'Infinity', '1e-7', 2.5, Number.NaN].map((v) => S.toDecimal(v))).toEqual([
      '5', '5.5', '0', '3', '0.5', '1000', '16', '-12', null, null, null, null, null, '2.5', null,
    ]);
  });

  it('slugOf folds accents and keeps ASCII letters and digits', () => {
    expect(S.slugOf('  Full Name (as on ID) ')).toBe('full_name_as_on_id');
    expect(S.slugOf('Crème brûlée')).toBe('creme_brulee');
    expect(S.slugOf('नाम')).toBe('');
  });

  it('hexColor accepts #rgb, #rrggbb and #rrggbbaa only', () => {
    expect(['#abc', '#A1B2C3', '#11223344', 'red', '#12345', 7, ' #fff '].map(S.hexColor)).toEqual(['#aabbcc', '#A1B2C3', '#11223344', undefined, undefined, undefined, '#ffffff']);
  });
});
