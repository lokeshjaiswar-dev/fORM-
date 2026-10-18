import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY, NOTHING_REMOVED, SEED_NAMESPACE, applyOptionalParts, pruneRemoved, bakeVariables, bindingOf, inverseRemapOf, isUuid, mapKey, orgValue, parseMapKey, partIncluded, remapOf,
  remapRefs, remapTextKey, resolveVariables, seedNamespace, uniqueKey, uuidv5, variableNames,
} from '../src/index.ts';
import { EVENT_VARIABLES, EN_IN, HI_IN, ORG_PROFILE, bid, eventPayload, id, inline, v } from './build.ts';

describe('uuidv5', () => {
  it('matches the RFC 9562 / Python reference vector', () => {
    expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
    expect(uuidv5('6BA7B810-9DAD-11D1-80B4-00C04FD430C8', 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('hashes UTF-8 names and sets the version and variant bits', () => {
    const id5 = uuidv5(SEED_NAMESPACE, 'नमस्ते 🙏');
    expect(isUuid(id5)).toBe(true);
    expect(id5[14]).toBe('5');
    expect('89ab').toContain(id5[19]);
    expect(uuidv5(SEED_NAMESPACE, 'a')).not.toBe(uuidv5(SEED_NAMESPACE, 'b'));
  });

  it('uses a UUID seed as its namespace and hashes any other seed into one', () => {
    expect(seedNamespace('6BA7B810-9DAD-11D1-80B4-00C04FD430C8')).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(seedNamespace('idem-key')).toBe(uuidv5(SEED_NAMESPACE, 'idem-key'));
    expect(() => uuidv5('not-a-uuid', 'x')).toThrow(TypeError);
  });
});

describe('remap', () => {
  it('keys non-element namespaces with a prefix and parses them back', () => {
    expect(mapKey('element', 'b1')).toBe('b1');
    expect(mapKey('rule', 'r1')).toBe('rule:r1');
    expect(parseMapKey('rule_group:g')).toEqual({ ns: 'rule_group', sourceId: 'g' });
    expect(parseMapKey('weird:x')).toEqual({ ns: 'element', sourceId: 'weird:x' });
  });

  it('maps ids and keys both ways, leaving unknown ids alone', () => {
    const forward = remapOf({ b1: 'n1', 'rule:r1': 'n2' }, { pan: 'pan_2' });
    expect([forward.id('element', 'b1'), forward.id('rule', 'r1'), forward.id('rule', 'b1'), forward.key('pan'), forward.key('x')]).toEqual(['n1', 'n2', 'b1', 'pan_2', 'x']);
    const back = inverseRemapOf({ b1: 'n1', 'rule:r1': 'n2' }, { pan: 'pan_2' });
    expect([back.id('element', 'n1'), back.id('rule', 'n2'), back.id('element', 'n2'), back.key('pan_2')]).toEqual(['b1', 'r1', 'n2', 'pan']);
    expect(IDENTITY.id('element', 'z')).toBe('z');
  });

  it('remaps every reference site and copies opaque payloads verbatim', () => {
    const map = remapOf({ b1: 'B1', p1: 'P1', e1: 'E1', 'variable:v1': 'V1', 'purpose:pu': 'PU', 'rule_group:g': 'G', 'condition:c': 'C' }, { k: 'k_2' });
    const input = {
      targets: ['b1', 'p1'], target: 'b1', children: ['b1', { kind: 'condition', id: 'c' }], skip: { type: 'skip_to_page', from: 'p1', to: 'p1' },
      bound: { kind: 'field', blockId: 'b1' }, emailBlockId: 'b1', endingId: 'e1', varId: 'v1', purposeIds: ['pu'], groupId: 'g',
      table: { type: 'answersTable', attrs: { include: ['b1'], hideEmpty: true, maskSensitive: true } }, carryKeys: ['k'],
      gradient: { from: 'b1', to: 'b1' }, 'x-ext': { blockId: 'b1' }, raw: { type: 'unsupported', raw: { blockId: 'b1' } },
    };
    expect(remapRefs(input, map)).toEqual({
      targets: ['B1', 'P1'], target: 'B1', children: ['B1', { kind: 'condition', id: 'C' }], skip: { type: 'skip_to_page', from: 'P1', to: 'P1' },
      bound: { kind: 'field', blockId: 'B1' }, emailBlockId: 'B1', endingId: 'E1', varId: 'V1', purposeIds: ['PU'], groupId: 'G',
      table: { type: 'answersTable', attrs: { include: ['B1'], hideEmpty: true, maskSensitive: true } }, carryKeys: ['k_2'],
      gradient: { from: 'b1', to: 'b1' }, 'x-ext': { blockId: 'b1' }, raw: { type: 'unsupported', raw: { blockId: 'b1' } },
    });
  });

  it('remaps the id inside a TextKey', () => {
    const map = remapOf({ b1: 'B1', 'purpose:pu': 'PU', 'rule:r': 'R' });
    expect(['block:b1:label', 'option:b1/o1', 'purpose:pu:name', 'rule:r:0', 'form:title', 'consent:b1:item:i1', 'nocolon'].map((k) => remapTextKey(k, map)))
      .toEqual(['block:B1:label', 'option:B1/o1', 'purpose:PU:name', 'rule:R:0', 'form:title', 'consent:B1:item:i1', 'nocolon']);
  });
});

describe('variables', () => {
  const ctx = { locale: EN_IN, orgProfile: ORG_PROFILE, brandKit: null, variables: {}, formTitle: 'Event' };

  it('defaults prompts to bake and the rest to live', () => {
    expect(bindingOf('custom.x')).toBe('bake');
    expect(bindingOf('org.legal_name')).toBe('live');
    expect(bindingOf('org.legal_name', { ...EVENT_VARIABLES[0]!, binding: 'bake' })).toBe('bake');
  });

  it('resolves org-profile values per locale, with the base field as fallback', () => {
    expect(orgValue('org.legal_name', ORG_PROFILE, HI_IN)).toBe('एक्मे प्रा. लि.');
    expect(orgValue('org.legal_name', ORG_PROFILE, EN_IN)).toBe('Acme Pvt Ltd');
    expect(orgValue('org.privacy_contact.email', ORG_PROFILE, EN_IN)).toBe('privacy@acme.example');
    expect(orgValue('org.cin', ORG_PROFILE, EN_IN)).toBeUndefined();
    expect(orgValue('org.unknown', ORG_PROFILE, EN_IN)).toBeUndefined();
    const withAddress: S.OrgProfile = { ...ORG_PROFILE, registeredAddress: { line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: id('IN') } };
    expect(orgValue('org.registered_address', withAddress, EN_IN)).toBe('1 MG Road, Bengaluru, Karnataka 560001, IN');
  });

  it('resolves bake variables from answers, org profile, brand kit, the form and defaults', () => {
    const brandKit: S.BrandKit = {
      id: id('kit'), orgId: id('org_acme'), isDefault: true, updatedBy: id('u'), updatedAt: id('2026-10-01T00:00:00Z'),
      tokens: {
        name: 'Acme', logos: { primary: id('asset_logo') }, colors: { primary: id('#112233'), secondary: id('#223344'), accent: id('#334455'), background: id('#ffffff'), surface: id('#fafafa'), text: id('#111111'), muted: id('#666666'), error: id('#cc0000'), success: id('#00aa00') },
        typography: { heading: id('inter'), body: id('noto-sans'), baseSize: 16 }, shape: { radius: 'md', density: 'comfortable' }, email: { footer: { type: 'doc', content: [] } }, pdf: {},
      },
    };
    const vars: S.TemplateVariable[] = [
      { name: 'custom.n', source: 'prompt', type: 'number', label: 'n', required: true, default: 3, binding: 'bake' },
      { name: 'org.legal_name', source: 'org_profile', type: 'text', label: 'l', required: true, binding: 'bake' },
      { name: 'brand.primary', source: 'brand_kit', type: 'color', label: 'b', required: false, binding: 'bake' },
      { name: 'brand.email_footer', source: 'brand_kit', type: 'rich', label: 'f', required: false, binding: 'bake' },
      { name: 'form.title', source: 'form', type: 'text', label: 't', required: false, binding: 'bake' },
      { name: 'form.public_url', source: 'form', type: 'url', label: 'u', required: true, binding: 'bake' },
      { name: 'org.dpo.name', source: 'org_profile', type: 'text', label: 'd', required: false, binding: 'live' },
    ];
    const r = resolveVariables(vars, { ...ctx, brandKit, variables: { 'custom.extra': true } }, ['custom.extra', 'custom.none']);
    expect(r.values).toEqual({ 'custom.n': '3', 'org.legal_name': 'Acme Pvt Ltd', 'brand.primary': '#112233', 'form.title': 'Event', 'custom.extra': 'true' });
    expect(r.missing).toEqual([{ name: 'brand.email_footer', required: false }, { name: 'form.public_url', required: true }, { name: 'custom.none', required: false }]);
    expect(resolveVariables(vars, { ...ctx, orgProfile: null }).missing.map((m) => m.name)).toContain('org.legal_name');
  });

  it('bakes rich-text and plain-template variables, merging text runs', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A ' }, v('custom.a'), { type: 'text', text: ' B' }, v('custom.empty'), { type: 'text', text: '!', marks: [{ type: 'bold' }] }, v('org.legal_name')] }] };
    const plain = ['x ', { var: { name: 'custom.a' } }, '', { var: { name: 'custom.gone', fallback: 'fb' } }];
    const values: Record<string, string> = { 'custom.a': 'one', 'custom.empty': '' };
    const out = bakeVariables({ doc, plain }, (n) => n.startsWith('custom.'), (n) => values[n]);
    expect(out.value.doc.content[0]?.content).toEqual([{ type: 'text', text: 'A one B' }, { type: 'text', text: '!', marks: [{ type: 'bold' }] }, v('org.legal_name')]);
    expect(out.value.plain).toEqual(['x onefb']);
    expect(out.unresolved).toEqual([]);
    const missing = bakeVariables(inline('Hi ', v('custom.who')), () => true, () => undefined);
    expect(missing.value).toEqual(inline('Hi ', v('custom.who')));
    expect(missing.unresolved).toEqual(['custom.who']);
  });

  it('lists the variables a value uses, once each', () => {
    expect(variableNames([inline(v('a.b' as S.TemplateVariableName)), { x: [{ var: { name: 'custom.c' } }] }, inline(v('a.b' as S.TemplateVariableName))])).toEqual(['a.b', 'custom.c']);
  });
});

describe('optional parts', () => {
  const payload = eventPayload();
  const part = payload.optionalParts?.[0];
  if (!part) throw new Error('fixture drifted');

  it('reads the Use-dialog answer, else the declared default', () => {
    expect(partIncluded(part, {}, payload.variables)).toBe(true);
    expect(partIncluded(part, { 'custom.dietary': false }, payload.variables)).toBe(false);
    expect(partIncluded(part, {}, [])).toBe(false);
  });

  it('removes pages, endings, variables and purposes, and prunes what pointed at them', () => {
    const def = payload.document;
    def.logic.variables = [{ id: id('v1'), key: id('score'), name: 'Score', type: 'number', expr: { k: 'lit', value: { type: 'number', value: id('1') } }, persist: false }];
    def.endings.push({ id: id('ending_2'), kind: 'message', name: 'Other', content: { type: 'doc', content: [] }, actions: [] });
    def.logic.rules.push({ id: id('r_jump'), enabled: true, when: { kind: 'group', id: id('g_j'), combinator: 'all', children: [] }, then: [{ type: 'skip_to_page', from: id('p1'), to: id('p2') }, { type: 'set_ending', endingId: id('ending_2') }, { type: 'block_submit', message: 'no', anchorBlockId: bid('utm') }] });
    def.logic.rules.push({ id: id('r_var'), enabled: true, when: { kind: 'group', id: id('g_v'), combinator: 'all', children: [{ kind: 'condition', id: id('c_v'), left: { kind: 'ref', ref: { kind: 'variable', varId: id('v1') } }, op: 'is_answered' }] }, then: [{ type: 'show', targets: [bid('utm')] }] });
    const parts: S.TemplateOptionalPart[] = [{ id: id('x'), label: 'x', when: { variable: 'custom.off', equals: true }, includes: { pageSourceIds: ['p2'], endingSourceIds: ['ending_2'], variableSourceIds: ['v1'], purposeSourceIds: ['kyc'] } }];
    const { definition, warnings } = applyOptionalParts(def, parts, {}, []);
    expect(definition.pages.map((p) => p.id)).toEqual(['p1']);
    expect(Object.keys(definition.blocks)).not.toContain('kyc');
    expect(Object.keys(definition.blocks)).not.toContain('pan_number');
    expect(definition.endings.map((e) => e.id)).toEqual(['ending_1']);
    expect(definition.logic.variables).toEqual([]);
    expect(definition.privacy.purposes.map((p) => p.id)).toEqual(['respond']);
    expect(definition.logic.rules.map((r) => r.id)).toEqual(['r_diet', 'r_phone', 'r_pan', 'r_jump']);
    expect(definition.logic.rules[2]?.then).toEqual([{ type: 'hide', targets: ['diet_notes'] }]);
    expect(definition.logic.rules[3]?.then).toEqual([{ type: 'block_submit', message: 'no' }]);
    expect(warnings.map((w) => w.at)).toEqual(['/logic/rules/4']);
    expect(applyOptionalParts(def, [], {}, [])).toEqual({ definition: def, warnings: [], removed: { blocks: new Set(), variables: new Set() } });
  });

  it('turns pipes to a removed block into their fallback and drops bounds and recipients on it', () => {
    const def = eventPayload().document;
    const parts: S.TemplateOptionalPart[] = [{ id: id('x'), label: 'x', when: { variable: 'custom.off', equals: true }, includes: { blockSourceIds: ['name', 'arrival'] } }];
    const withRecipient = { ...def, x: { 'x-keep': { kind: 'field', blockId: 'name' } } } as S.FormDefinition;
    const { definition } = applyOptionalParts(withRecipient, parts, {}, []);
    const greeting = definition.blocks[bid('greeting')];
    expect(greeting?.type === 'paragraph' && greeting.config.content.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Hello there, see you at ' }, v('custom.venue', 'the venue'), { type: 'text', text: '.' }] });
    const departure = definition.blocks[bid('departure')];
    expect(departure?.type === 'date' && departure.config.limits).toEqual({});
    expect(definition.x).toEqual({ 'x-keep': { kind: 'field', blockId: 'name' } });
    const pruned = applyOptionalParts({ ...def, logic: { ...def.logic, rules: [] } }, parts, {}, []).definition;
    const route: S.Rule = { id: id('r'), enabled: true, when: { kind: 'group', id: id('g'), combinator: 'all', children: [] }, then: [{ type: 'route_email', notificationId: id('n'), field: 'to', mode: 'add', recipients: [{ kind: 'field', blockId: bid('name') }, { kind: 'role', role: 'form_owner' }] }] };
    const routed = applyOptionalParts({ ...def, logic: { ...def.logic, rules: [route] } }, parts, {}, []).definition;
    expect(routed.logic.rules[0]?.then).toEqual([{ type: 'route_email', notificationId: 'n', field: 'to', mode: 'add', recipients: [{ kind: 'role', role: 'form_owner' }] }]);
    expect(pruned.logic.rules).toEqual([]);
  });
});

describe('pruneRemoved', () => {
  const removed = { blocks: new Set(['dob', 'proof', 'gpage', 'buyer']), variables: new Set<string>() };
  const guardian = { guardianEmailBlockId: 'g', methods: ['manual_document_review'], expiryHours: 48 };
  const children = { mode: 'age_gate', subject: 'respondent', dobBlockId: 'dob', adultAge: 18, underAge: { kind: 'parental_consent', guardian: { ...guardian, evidenceUploadBlockId: 'proof', pageId: 'gpage' } }, disableTrackingForMinors: true };

  it('drops optional references to a removed block and reports required ones it cannot prune', () => {
    const warnings: S.TemplateWarning[] = [];
    const out = pruneRemoved({ children, billing: { nameBlockId: 'buyer', emailBlockId: 'e' }, inventory: { blockIds: ['buyer', 'e'] } }, removed, '/privacy', warnings);
    expect(out).toEqual({ children: { ...children, underAge: { kind: 'parental_consent', guardian } }, billing: { emailBlockId: 'e' }, inventory: { blockIds: ['e'] } });
    expect(warnings).toEqual([{ code: 'part_removed_rule', message: "'dobBlockId' still refers to 'dob', which an optional part removed", at: '/privacy/children/dobBlockId' }]);
  });

  it('returns its input when nothing was removed', () => {
    const warnings: S.TemplateWarning[] = [];
    expect(pruneRemoved(children, NOTHING_REMOVED, '', warnings)).toBe(children);
    expect(warnings).toEqual([]);
  });
});

describe('uniqueKey', () => {
  it('suffixes and keeps keys within 64 characters', () => {
    expect(uniqueKey('pan', new Set(['pan', 'pan_2']))).toBe('pan_3');
    expect(uniqueKey('free', new Set())).toBe('free');
    const long = 'k'.repeat(64);
    expect(uniqueKey(long, new Set([long]))).toBe(`${'k'.repeat(62)}_2`);
  });
});
