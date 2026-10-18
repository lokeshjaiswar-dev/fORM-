import { validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { InsertSnippetResultSchema, canonicalJson, contentHash, toPlain, validateStructure } from '@form/schema';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { TemplateCoreError, applyDocumentOps, insertSnippet, seedNamespace, uuidv5 } from '../src/index.ts';
import { EN_IN, HI_IN, bid, context, eventPayload, field, hostForm, id, inline, kycSnippet, onceSnippet, pid, versionOf } from './build.ts';

const { newFormId: _n, include: _i, ...ctx } = context({ idSeed: 'snippet-key', bindingIdSeed: 'snippet-binding', variables: { 'custom.bank': 'Canara Bank' } });
const errors = (def: S.FormDefinition) => validateDefinition(def, 'save', REGISTRY).filter((i) => i.severity === 'error');
const dangling = (def: S.FormDefinition) => validateStructure(def, { mode: 'publish' }).filter((i) => i.code === 'dangling_ref');
const KYC_VERSION = versionOf(kycSnippet(), 'tpl_kyc', 'tplv_kyc_1');
const KYC_BINDING = insertSnippet(KYC_VERSION, hostForm(), { pageId: id<S.PageId>('p1') }, ctx).binding;

describe('insertSnippet', () => {
  const host = hostForm();
  const result = insertSnippet(KYC_VERSION, host, { pageId: pid('p1') }, ctx);
  const after = applyDocumentOps(host, result.ops);
  const ns = seedNamespace('snippet-key');

  it('returns ops its zod twin accepts that apply to a valid draft without dangling references', () => {
    expect(InsertSnippetResultSchema.safeParse(result).error).toBeUndefined();
    expect(errors(after)).toEqual([]);
    expect(dangling(after)).toEqual([]);
    expect(result.ops.map((o) => o.op)).toEqual(['add_block', 'add_block', 'add_block', 'add_rule', 'set_messages']);
  });

  it('suffixes clashing keys and maps every snippet key', () => {
    expect(result.keyMap).toEqual({ pan: 'pan_2', pan_name: 'pan_name' });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'key_renamed', at: 'pan' }));
    const keys = Object.values(after.blocks).flatMap((b) => (b && 'key' in b ? [b.key] : []));
    expect(keys.filter((k) => k === 'pan_2')).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.binding).toMatchObject({ kind: 'snippet', keyMap: result.keyMap, instanceRootId: uuidv5(ns, 'kyc'), formId: 'form_1', templateId: 'tpl_kyc' });
  });

  it('adds the subtree at the preferred position, with remapped children and rules', () => {
    const root = uuidv5(ns, 'kyc');
    expect(after.pages[0]?.children).toEqual([bid('full'), bid('old_pan'), root]);
    const section = after.blocks[root as S.BlockId];
    expect(section?.type === 'section' && section.config.children).toEqual([uuidv5(ns, 'pan'), uuidv5(ns, 'pan_name')]);
    expect(section?.type === 'section' && toPlain(section.config.title ?? { type: 'doc', content: [{ type: 'paragraph' }] })).toBe('KYC for Canara Bank');
    const r = after.logic.rules.at(-1);
    expect(r?.id).toBe(uuidv5(ns, 'rule:r_kyc'));
    expect(r?.then).toEqual([{ type: 'require', targets: [uuidv5(ns, 'pan_name')] }]);
    expect(r?.origin).toEqual({ bindingId: result.binding.id, sourceId: 'r_kyc' });
  });

  it('reuses a purpose the form already declares', () => {
    expect(result.ops.some((o) => o.op === 'add_purpose')).toBe(false);
    const panBlock = after.blocks[uuidv5(ns, 'pan') as S.BlockId];
    expect(panBlock && 'compliance' in panBlock && panBlock.compliance.purposeIds).toEqual(['kyc']);
    const fresh = hostForm();
    fresh.privacy.purposes = fresh.privacy.purposes.filter((p) => p.id !== 'kyc');
    const added = insertSnippet(KYC_VERSION, fresh, { pageId: pid('p1') }, ctx);
    const purposeOp = added.ops.find((o) => o.op === 'add_purpose');
    expect(purposeOp?.op === 'add_purpose' && purposeOp.purpose.id).toBe(uuidv5(ns, 'purpose:kyc'));
    expect(errors(applyDocumentOps(fresh, added.ops))).toEqual([]);
  });

  it('copies translations with remapped keys, and reports locales the snippet lacks', () => {
    const messages = result.ops.find((o) => o.op === 'set_messages');
    expect(messages?.op === 'set_messages' && Object.keys(messages.entries).sort()).toEqual([`block:${uuidv5(ns, 'pan')}:label`, `rule:${uuidv5(ns, 'rule:r_kyc')}:0`]);
    expect(after.i18n.messages[HI_IN]?.[`block:${uuidv5(ns, 'pan')}:label`]?.origin).toBe('template');
    const ta = hostForm();
    ta.i18n.locales.push({ locale: id('ta-IN'), direction: 'ltr' });
    expect(insertSnippet(KYC_VERSION, ta, { pageId: pid('p1') }, ctx).warnings).toContainEqual(expect.objectContaining({ code: 'locale_incomplete', at: 'ta-IN' }));
  });

  it('inserts after a block, in its page or its container', () => {
    const afterFull = applyDocumentOps(host, insertSnippet(KYC_VERSION, host, { pageId: pid('p1'), afterBlockId: bid('full') }, ctx).ops);
    expect(afterFull.pages[0]?.children).toEqual([bid('full'), uuidv5(ns, 'kyc'), bid('old_pan')]);
    const inBox = applyDocumentOps(host, insertSnippet(KYC_VERSION, host, { pageId: pid('p2'), afterBlockId: bid('inner') }, ctx).ops);
    const box = inBox.blocks[bid('box')];
    expect(box?.type === 'section' && box.config.children).toEqual([bid('inner'), uuidv5(ns, 'kyc')]);
    const start = applyDocumentOps(host, insertSnippet(versionOf(onceSnippet()), host, { pageId: pid('p2') }, ctx).ops);
    expect(start.pages[1]?.children[0]).toBe(uuidv5(ns, 'terms'));
  });

  it('is deterministic per seed and disjoint across seeds', () => {
    expect(canonicalJson(insertSnippet(KYC_VERSION, host, { pageId: pid('p1') }, ctx))).toBe(canonicalJson(result));
    const other = insertSnippet(KYC_VERSION, after, { pageId: pid('p1') }, { ...ctx, idSeed: 'other-key' });
    const added = (ops: S.DocumentOp[]) => ops.flatMap((o): string[] => (o.op === 'add_block' ? [o.block.id] : o.op === 'add_rule' ? [o.rule.id] : []));
    const mine = new Set(added(result.ops));
    expect(added(other.ops).filter((x) => mine.has(x))).toEqual([]);
    const twice = applyDocumentOps(after, other.ops);
    expect(errors(twice)).toEqual([]);
    expect(Object.values(twice.blocks).filter((b) => b && 'key' in b && b.key.startsWith('pan_')).map((b) => b && 'key' in b && b.key).sort()).toEqual(['pan_2', 'pan_3', 'pan_name', 'pan_name_2']);
  });

  it('refuses a once-per-form snippet the form already holds, an unknown page or block, and other kinds', () => {
    const once = versionOf(onceSnippet());
    const withTerms = applyDocumentOps(host, insertSnippet(once, host, { pageId: pid('p1') }, ctx).ops);
    const thrown = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof TemplateCoreError ? e.code : 'other';
      }
      return null;
    };
    expect(thrown(() => insertSnippet(once, withTerms, { pageId: pid('p1') }, { ...ctx, idSeed: 'again' }))).toBe('snippet_already_inserted');
    expect(thrown(() => insertSnippet(KYC_VERSION, host, { pageId: pid('nope') }, ctx))).toBe('page_not_found');
    expect(thrown(() => insertSnippet(KYC_VERSION, host, { pageId: pid('p1'), afterBlockId: bid('nope') }, ctx))).toBe('block_not_found');
    expect(thrown(() => insertSnippet(versionOf(eventPayload()), host, { pageId: pid('p1') }, ctx))).toBe('wrong_template_kind');
    const broken = { ...kycSnippet(), rootId: bid('missing') };
    expect(thrown(() => insertSnippet(versionOf(broken), host, { pageId: pid('p1') }, ctx))).toBe('block_not_found');
  });

  it('recognises an earlier once-per-form insert by its binding, not by a source id another template also uses', () => {
    const once = versionOf(onceSnippet(), 'tpl_once', 'tplv_once_1');
    const lookalike = hostForm();
    lookalike.blocks[bid('terms_x')] = { ...field('consent', 'terms_x'), origin: { bindingId: id('some-form-template-binding'), sourceId: 'terms' } };
    lookalike.pages[0]?.children.push(bid('terms_x'));
    const formBinding = { ...KYC_BINDING, id: id<S.TemplateBindingId>('some-form-template-binding'), kind: 'form' as const, templateId: id<S.TemplateId>('tpl_event') };
    expect(insertSnippet(once, lookalike, { pageId: pid('p1') }, ctx, { bindings: [formBinding] }).ops).toHaveLength(1);
    expect(() => insertSnippet(once, lookalike, { pageId: pid('p1') }, ctx)).toThrow(TemplateCoreError);
    const first = insertSnippet(once, lookalike, { pageId: pid('p1') }, ctx, { bindings: [formBinding] });
    const withTerms = applyDocumentOps(lookalike, first.ops);
    expect(() => insertSnippet(once, withTerms, { pageId: pid('p2') }, { ...ctx, idSeed: 'again' }, { bindings: [formBinding, first.binding] })).toThrow('once per form');
  });

  it('inserts a snippet written in another default locale in the form default locale, keeping its own text as messages', () => {
    const payload = kycSnippet();
    const panBlock = payload.blocks[bid('pan')];
    if (panBlock?.type !== 'short_text') throw new Error('fixture drifted');
    payload.blocks[bid('pan')] = { ...panBlock, label: inline('पैन संख्या') };
    const english = inline('PAN number');
    payload.i18n = { defaultLocale: HI_IN, locales: [{ locale: HI_IN, direction: 'ltr' }, { locale: EN_IN, direction: 'ltr' }], messages: { [EN_IN]: { 'block:pan:label': { value: english, sourceHash: contentHash(inline('पैन संख्या')), origin: 'human' } } } };
    const r = insertSnippet(versionOf(payload, 'tpl_kyc_hi'), host, { pageId: pid('p1') }, ctx);
    const next = applyDocumentOps(host, r.ops);
    const instancePan = next.blocks[uuidv5(ns, 'pan') as S.BlockId];
    expect(instancePan && 'label' in instancePan && instancePan.label).toEqual(english);
    expect(next.i18n.messages[HI_IN]?.[`block:${uuidv5(ns, 'pan')}:label`]).toEqual({ value: inline('पैन संख्या'), sourceHash: contentHash(english), origin: 'template' });
    expect(r.warnings.filter((w) => w.code === 'locale_incomplete')).toEqual([]);
    expect(errors(next)).toEqual([]);

    const { [EN_IN]: _en, ...none } = payload.i18n.messages;
    const untranslated = insertSnippet(versionOf({ ...payload, i18n: { ...payload.i18n, messages: none } }), host, { pageId: pid('p1') }, ctx);
    expect(untranslated.warnings).toContainEqual(expect.objectContaining({ code: 'locale_incomplete', at: EN_IN }));
    expect(untranslated.ops.some((o) => o.op === 'set_messages')).toBe(false);
  });

  it('adds logic variables with unique keys', () => {
    const payload = kycSnippet();
    payload.logicVariables = [{ id: id('v_score'), key: id('full'), name: 'Score', type: 'number', expr: { k: 'lit', value: { type: 'number', value: id('1') } }, persist: false }];
    const r = insertSnippet(versionOf(payload), host, { pageId: pid('p1') }, ctx);
    const op = r.ops.find((o) => o.op === 'add_variable');
    expect(op?.op === 'add_variable' && op.variable).toMatchObject({ id: uuidv5(ns, 'variable:v_score'), key: 'full_2' });
  });
});

describe('applyDocumentOps', () => {
  it('places a block at its index once, whatever the parent already lists', () => {
    const host = hostForm();
    const block = field('short_text', 'extra');
    const op: S.DocumentOp = { op: 'add_block', block, parent: { pageId: pid('p1') }, index: 1 };
    const once = applyDocumentOps(host, [op]);
    expect(applyDocumentOps(once, [op])).toEqual(once);
    expect(once.pages[0]?.children).toEqual([bid('full'), bid('extra'), bid('old_pan')]);
    const rule: S.DocumentOp = { op: 'add_rule', index: 0, rule: { id: id('r0'), enabled: true, when: { kind: 'group', id: id('g'), combinator: 'all', children: [] }, then: [] } };
    expect(applyDocumentOps(host, [rule]).logic.rules[0]?.id).toBe('r0');
    const messages = applyDocumentOps(host, [{ op: 'set_messages', locale: EN_IN, entries: {} }]);
    expect(messages.i18n.messages[EN_IN]).toEqual({});
  });
});
