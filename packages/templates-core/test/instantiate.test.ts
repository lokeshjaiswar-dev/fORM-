import { validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { InstantiateResultSchema, canonicalJson, toPlain, validateStructure } from '@form/schema';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { OFFLINE_ACTOR, ROOT_SOURCE_ID, TemplateCoreError, instantiate, mapKey, seedNamespace, uuidv5 } from '../src/index.ts';
import { conditionIds } from '../src/shared.ts';
import { EN_IN, HI_IN, ORG_PROFILE, bid, context, eventPayload, id, kycSnippet, themePayload, versionOf } from './build.ts';

const errors = (def: S.FormDefinition) => validateDefinition(def, 'save', REGISTRY).filter((i) => i.severity === 'error');
const dangling = (def: S.FormDefinition) => validateStructure(def, { mode: 'publish' }).filter((i) => i.code === 'dangling_ref');
const run = (ctx: Partial<S.InstantiateContext> = {}, payload = eventPayload()) => instantiate(versionOf(payload), context(ctx));
const blockBySource = (def: S.FormDefinition, sourceId: string) => Object.values(def.blocks).find((b) => b && b.type !== 'unsupported' && b.origin?.sourceId === sourceId);

describe('instantiate', () => {
  const result = run();
  const def = result.definition;
  const ns = seedNamespace('idem-key-1');

  it('returns a result its zod twin accepts, and a draft that passes validateDefinition(…, save) with no dangling reference', () => {
    expect(InstantiateResultSchema.safeParse(result).error).toBeUndefined();
    expect(errors(def)).toEqual([]);
    expect(dangling(def)).toEqual([]);
  });

  it('gives every block, page, ending, rule, group, variable, purpose and condition the id uuidv5(idSeed, sourceId)', () => {
    expect(Object.keys(def.blocks)).toContain(uuidv5(ns, 'name'));
    expect(def.pages.map((p) => p.id)).toEqual([uuidv5(ns, 'p1'), uuidv5(ns, 'p2')]);
    expect(def.endings[0]?.id).toBe(uuidv5(ns, 'ending_1'));
    expect(def.defaultEndingId).toBe(uuidv5(ns, 'ending_1'));
    expect(def.logic.rules.map((r) => r.id)).toEqual(['r_diet', 'r_phone', 'r_pan'].map((r) => uuidv5(ns, mapKey('rule', r))));
    expect(def.logic.ruleGroups[0]?.id).toBe(uuidv5(ns, 'rule_group:grp'));
    expect(def.logic.rules[0]?.groupId).toBe(uuidv5(ns, 'rule_group:grp'));
    expect(def.privacy.purposes.map((p) => p.id)).toEqual([uuidv5(ns, 'purpose:respond'), uuidv5(ns, 'purpose:kyc')]);
    expect(def.logic.rules[0]?.when.id).toBe(uuidv5(ns, 'condition:g_diet'));
    expect(def.formId).toBe('form_new');
  });

  it('keeps option ids and remaps every reference', () => {
    const diet = blockBySource(def, 'diet');
    const notes = blockBySource(def, 'diet_notes');
    const kyc = blockBySource(def, 'kyc');
    const panBlock = blockBySource(def, 'pan_number');
    expect(diet?.type === 'single_choice' && diet.config.options.map((o) => o.id)).toEqual(['veg', 'nonveg']);
    const [rDiet] = def.logic.rules;
    expect(rDiet?.then).toEqual([{ type: 'show', targets: [notes?.id] }]);
    const c = rDiet?.when.children[0];
    expect(c?.kind === 'condition' && c.left).toEqual({ kind: 'ref', ref: { kind: 'answer', blockId: diet?.id } });
    expect(c?.kind === 'condition' && c.right).toEqual({ kind: 'options', blockId: diet?.id, optionIds: ['nonveg'] });
    expect(kyc?.type === 'section' && kyc.config.children).toEqual([panBlock?.id]);
    const departure = blockBySource(def, 'departure');
    expect(departure?.type === 'date' && departure.config.limits?.min).toEqual({ kind: 'field', blockId: blockBySource(def, 'arrival')?.id });
    const greeting = blockBySource(def, 'greeting');
    expect(JSON.stringify(greeting)).toContain(`"blockId":"${blockBySource(def, 'name')?.id}"`);
    expect(Object.keys(def.i18n.messages[HI_IN] ?? {}).sort()).toEqual([
      `block:${blockBySource(def, 'name')?.id}:label`, `ending:${def.endings[0]?.id}:content`, 'form:title', `option:${diet?.id}/veg`,
      `page:${def.pages[0]?.id}:title`, `purpose:${def.privacy.purposes[0]?.id}:name`, `rule:${rDiet?.id}:0`,
    ].sort());
    expect(Object.values(def.i18n.messages[HI_IN] ?? {}).every((e) => e?.origin === 'template')).toBe(true);
  });

  it('stamps an origin on every block, page, rule, variable, ending and purpose', () => {
    const [form] = result.bindings;
    expect(form?.kind).toBe('form');
    for (const item of [...Object.values(def.blocks), ...def.pages, def.endings[0], ...def.logic.rules, ...def.privacy.purposes]) {
      expect(item && 'origin' in item && item.origin?.bindingId).toBe(form?.id);
    }
    expect(def.pages.map((p) => p.origin?.sourceId)).toEqual(['p1', 'p2']);
    const ids = new Set(Object.values(form?.idMap ?? {}));
    expect(Object.keys(def.blocks).every((b) => ids.has(b))).toBe(true);
  });

  it('bakes prompt variables, keeps live ones, uses fallbacks and reports what is missing', () => {
    const name = blockBySource(def, 'name');
    expect(name && 'label' in name && name.label).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name for Diwali Mela' }] }] });
    const intro = blockBySource(def, 'intro');
    expect(intro?.type === 'heading' && intro.config.subheading?.content[0].content).toEqual([{ type: 'text', text: 'Hosted by ' }, { type: 'var', attrs: { name: 'org.legal_name' } }]);
    const greeting = blockBySource(def, 'greeting');
    expect(greeting?.type === 'paragraph' && toPlain(greeting.config.content)).toBe('Hello there, see you at the venue.');
    expect(def.pages[0]?.title).toEqual(['About you at Diwali Mela']);
    expect(JSON.stringify(def.i18n.messages)).toContain('नाम (Diwali Mela)');
    expect(result.warnings.filter((w) => w.code === 'variable_missing')).toEqual([]);

    const missing = run({ variables: {} });
    expect(missing.warnings).toContainEqual(expect.objectContaining({ code: 'variable_missing', at: 'custom.event_name' }));
    const label = blockBySource(missing.definition, 'name');
    expect(label && 'label' in label && label.label.content[0].content).toContainEqual({ type: 'var', attrs: { name: 'custom.event_name' } });
    expect(errors(missing.definition)).toEqual([]);
  });

  it('removes an optional part whose condition is false, with the rules that depend on it', () => {
    expect(blockBySource(def, 'diet')).toBeDefined();
    const without = run({ variables: { 'custom.event_name': 'Mela', 'custom.dietary': false } });
    const d = without.definition;
    expect(blockBySource(d, 'diet')).toBeUndefined();
    expect(blockBySource(d, 'diet_notes')).toBeUndefined();
    expect(d.logic.rules.map((r) => r.origin?.sourceId)).toEqual(['r_phone']);
    expect(without.warnings).toContainEqual(expect.objectContaining({ code: 'part_removed_rule', at: '/logic/rules/2' }));
    expect(Object.keys(d.i18n.messages[HI_IN] ?? {}).some((k) => k.startsWith('option:'))).toBe(false);
    expect(errors(d)).toEqual([]);
    expect(dangling(d)).toEqual([]);
  });

  it('prunes what the applied refs read from a removed optional part, and reports what it cannot prune', () => {
    const payload = eventPayload();
    payload.variables.push({ name: 'custom.contact', source: 'prompt', type: 'boolean', label: 'Ask for contact details?', required: false, default: true, binding: 'bake' });
    payload.optionalParts?.push({ id: id('part_contact'), label: 'Contact details', when: { variable: 'custom.contact', equals: true }, includes: { blockSourceIds: ['email', 'phone'] } });
    const r = run({ variables: { 'custom.event_name': 'Mela', 'custom.dietary': false, 'custom.contact': false } }, payload);
    const d = r.definition;
    const blockIds: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') {
        const rec = value as Record<string, unknown>;
        for (const [k, child] of Object.entries(rec)) {
          if (/^(blockId|[a-z][A-Za-z]*BlockId)$/.test(k) && typeof child === 'string') blockIds.push(child);
          else if (k === 'include' && rec['hideEmpty'] !== undefined && Array.isArray(child)) blockIds.push(...child.filter((b): b is string => typeof b === 'string'));
          else collect(child);
        }
      }
    };
    collect([r.ops, r.workflow]);
    expect(blockIds.length).toBeGreaterThan(0);
    expect(blockIds.filter((b) => d.blocks[b as S.BlockId] === undefined)).toEqual([]);
    expect(r.workflow?.steps[0]).toMatchObject({ kind: 'branch', branches: [], otherwise: 's2' });
    expect(r.workflow?.steps[1]).toMatchObject({ kind: 'approval', approver: { kind: 'role', role: 'form_owner' } });
    const [auto] = r.ops.notifications;
    expect(auto?.to).toEqual([]);
    expect(auto?.body.content[1]).toEqual({ type: 'answersTable', attrs: { include: [blockBySource(d, 'name')?.id], hideEmpty: true, maskSensitive: true } });
    expect(r.ops.pdfTemplates[0]?.passwordFrom).toBeUndefined();
    expect(r.warnings.filter((w) => w.code === 'part_removed_rule').map((w) => w.at)).toEqual([
      '/logic/rules/1', '/logic/rules/2', '/refs/emails/0/defaultRecipients', '/refs/workflow/workflow/steps/0/branches/0', '/refs/workflow/workflow/steps/1/approver',
    ]);
    expect(errors(d)).toEqual([]);
    expect(dangling(d)).toEqual([]);
  });

  it('skips a second ending ref for a status screen that is already filled', () => {
    const payload = eventPayload();
    const closed = payload.refs?.endings?.[1];
    if (!payload.refs || !closed || !('kind' in closed)) throw new Error('fixture drifted');
    payload.refs.endings = [...(payload.refs.endings ?? []), { ...closed, content: { type: 'doc', content: [] } }];
    const r = run({}, payload);
    expect(toPlain(r.ops.screens.closed?.content ?? { type: 'doc', content: [] })).toBe('Registrations for Diwali Mela are closed.');
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: 'feature_unavailable', at: '/refs/endings/2' }));
    expect(r.bindings.filter((b) => b.kind === 'ending')).toHaveLength(2);
  });

  it('applies the refs, each with its own binding', () => {
    const kinds = result.bindings.map((b) => b.kind);
    expect(kinds).toEqual(['form', 'theme', 'ending', 'ending', 'email', 'email', 'pdf', 'workflow']);
    expect(new Set(result.bindings.map((b) => b.id)).size).toBe(kinds.length);
    expect(def.theme).toEqual({ layout: 'cards', tokens: themePayload().tokens, customCss: themePayload().customCss });
    expect(def.endings.map((e) => e.kind)).toEqual(['message', 'message']);
    expect(def.endings[1]?.origin).toEqual({ bindingId: result.bindings[2]?.id, sourceId: ROOT_SOURCE_ID });
    expect(toPlain(result.ops.screens.closed?.content ?? { type: 'doc', content: [] })).toBe('Registrations for Diwali Mela are closed.');
    const [auto, owner] = result.ops.notifications;
    expect(auto?.kind).toBe('autoresponder');
    expect(auto?.to).toEqual([{ kind: 'field', blockId: blockBySource(def, 'email')?.id }]);
    expect(auto?.subject).toEqual(['You are registered for Diwali Mela']);
    expect(owner?.to).toEqual([{ kind: 'role', role: 'form_owner' }]);
    expect(owner?.purposeIds).toEqual(def.privacy.purposes.map((p) => p.id));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'feature_unavailable', at: '/refs/emails/2' }));
    expect(result.ops.pdfTemplates[0]?.passwordFrom).toEqual({ blockId: blockBySource(def, 'phone')?.id });
    const branch = result.workflow?.steps[0];
    expect(branch?.kind === 'branch' && JSON.stringify(branch.branches)).toContain(blockBySource(def, 'diet')?.id);
    expect(result.workflow?.id).toBe(uuidv5(ns, 'refs/workflow/wf'));
  });

  it('skips refs the Use dialog unticked, and resolves or reports referenced templates', () => {
    const none = run({ include: { theme: false, emails: false, endings: false, pdf: false, workflow: false } });
    expect(none.bindings.map((b) => b.kind)).toEqual(['form']);
    expect(none.ops).toEqual({ notifications: [], pdfTemplates: [], screens: {} });
    expect(none.definition.theme).toEqual(eventPayload().document.theme);
    expect(none.workflow).toBeUndefined();

    const ref: S.TemplateRef = { templateId: id('tpl_theme'), versionId: id('tplv_theme_3') };
    const payload = { ...eventPayload(), refs: { theme: ref } };
    const theme = versionOf(themePayload(), 'tpl_theme', 'tplv_theme_3');
    const resolved = instantiate(versionOf(payload), context(), { resolveRef: (r) => (r.versionId === theme.id ? theme : undefined) });
    expect(resolved.definition.theme.presetRef).toEqual({ templateId: 'tpl_theme', versionId: 'tplv_theme_3' });
    expect(resolved.bindings[1]).toMatchObject({ kind: 'theme', templateId: 'tpl_theme', templateVersionId: 'tplv_theme_3' });
    const unresolved = instantiate(versionOf(payload), context());
    expect(unresolved.warnings).toContainEqual(expect.objectContaining({ code: 'feature_unavailable', at: '/refs/theme' }));
    expect(unresolved.bindings).toHaveLength(1);
  });

  it('never copies analytics ids', () => {
    expect(eventPayload().document.behavior.analytics).toBeDefined();
    expect(def.behavior.analytics).toBeUndefined();
  });

  it('keeps the requested locales the template has and reports the others', () => {
    expect(def.i18n.locales.map((l) => l.locale)).toEqual([EN_IN, HI_IN]);
    const en = run({ extraLocales: [id('ta-IN')] });
    expect(en.definition.i18n.locales.map((l) => l.locale)).toEqual([EN_IN]);
    expect(en.definition.i18n.messages).toEqual({});
    expect(en.definition.i18n.reviewedConsentLocales).toEqual([EN_IN]);
    expect(en.warnings).toContainEqual(expect.objectContaining({ code: 'locale_incomplete', at: 'ta-IN' }));
  });

  it('warns about sensitive fields', () => {
    expect(result.warnings).toContainEqual({ code: 'sensitive_fields', message: 'This template contains sensitive fields (PAN); encryption is on by default.' });
  });

  it('writes bindings for the actor, or the offline stand-in', () => {
    expect(result.bindings[0]).toMatchObject({ orgId: OFFLINE_ACTOR.orgId, appliedBy: OFFLINE_ACTOR.userId, appliedAt: '2026-10-18T10:00:00Z', formId: 'form_new', updateState: 'current', governance: 'bound' });
    const actor = { orgId: id<S.OrgId>('org_acme'), userId: id<S.UserId>('user_1') };
    const withActor = instantiate(versionOf(eventPayload()), context(), { actor });
    expect(withActor.bindings.every((b) => b.orgId === 'org_acme' && b.appliedBy === 'user_1')).toBe(true);
    expect(result.bindings[0]?.keyMap).toMatchObject({ name: 'name', pan: 'pan' });
  });

  it('is deterministic, and different seeds give disjoint ids', () => {
    expect(canonicalJson(run())).toBe(canonicalJson(result));
    const other = run({ idSeed: 'idem-key-2' });
    const ids = (d: S.FormDefinition) => [
      ...Object.keys(d.blocks), ...d.pages.map((p) => p.id), ...d.endings.map((e) => e.id), ...d.logic.rules.map((r) => r.id), ...d.logic.ruleGroups.map((g) => g.id),
      ...d.logic.variables.map((x) => x.id), ...d.privacy.purposes.map((p) => p.id), ...conditionIds(d.logic),
    ];
    const mine = new Set(ids(def));
    expect(ids(other.definition).filter((x) => mine.has(x))).toEqual([]);
    expect(other.bindings.map((b) => b.id)).toEqual(result.bindings.map((b) => b.id));
    const rebound = run({ bindingIdSeed: 'binding-seed-2' });
    expect(Object.keys(rebound.definition.blocks)).toEqual(Object.keys(def.blocks));
    expect(rebound.bindings.some((b) => result.bindings.some((r) => r.id === b.id))).toBe(false);
  });

  it('accepts a UUID seed as the namespace itself', () => {
    const seed = '0F6B8E2A-1C3D-4E5F-8A9B-0C1D2E3F4A5B';
    const r = run({ idSeed: seed });
    expect(r.definition.pages[0]?.id).toBe(uuidv5(seed.toLowerCase(), 'p1'));
  });

  it('does not touch its input', () => {
    const payload = eventPayload();
    const before = canonicalJson(payload);
    instantiate(versionOf(payload), context({ variables: { 'custom.dietary': false } }));
    expect(canonicalJson(payload)).toBe(before);
  });

  it('refuses other template kinds', () => {
    expect(() => instantiate(versionOf(kycSnippet()), context())).toThrow(TemplateCoreError);
  });

  it('resolves baked org-profile values per locale', () => {
    const payload = eventPayload();
    payload.variables = payload.variables.map((x) => (x.name === 'org.legal_name' ? { ...x, binding: 'bake' } : x));
    const r = instantiate(versionOf(payload), context({ orgProfile: ORG_PROFILE }));
    const intro = blockBySource(r.definition, 'intro');
    expect(intro?.type === 'heading' && toPlain(intro.config.subheading ?? { type: 'doc', content: [{ type: 'paragraph' }] })).toBe('Hosted by Acme Pvt Ltd');
    const pdf = r.ops.pdfTemplates[0];
    expect(pdf?.footer && toPlain(pdf.footer)).toBe('Acme Pvt Ltd');
    expect(bid('x')).toBe('x');
  });
});
