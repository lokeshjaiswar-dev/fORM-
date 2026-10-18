import { describe, expect, it } from 'vitest';
import type * as S from '../src/index.ts';
import { FormDefinitionSchema, validateStructure } from '../src/index.ts';
import { definition, id, ids, inline } from './fixtures.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const codes = (issues: S.PublishIssue[]) => issues.map((i) => `${i.severity}:${i.code}:${i.path}`);
const blockOf = <T extends S.BlockType>(def: S.FormDefinition, blockId: S.BlockId, type: T): S.BlockOf<T> => {
  const b = def.blocks[blockId];
  if (b?.type !== type) throw new Error(`fixture block ${blockId} is not ${type}`);
  return b as S.BlockOf<T>;
};

describe('validateStructure', () => {
  it('accepts the fixture in both modes', () => {
    const def = definition();
    expect(FormDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateStructure(def)).toEqual([]);
    expect(validateStructure(def, { mode: 'publish' })).toEqual([]);
  });

  describe('I1 ids', () => {
    it('blocks, pages and endings share one namespace', () => {
      const def = definition();
      def.pages[1] = { ...def.pages[1]!, id: id<S.PageId>(ids.name) };
      expect(codes(validateStructure(def))).toContain('error:duplicate_id:/pages/1/id');
    });

    it('a block key must equal its id', () => {
      const def = definition();
      def.blocks[ids.name] = { ...blockOf(def, ids.name, 'short_text'), id: id<S.BlockId>('other') };
      expect(codes(validateStructure(def))).toContain('error:duplicate_id:/blocks/name_1/id');
    });

    it('options, rules and conditions are unique', () => {
      const def = definition();
      const choice = blockOf(def, ids.marketing, 'single_choice');
      choice.config.options[1] = { id: ids.yes, label: 'Again' };
      def.logic.rules.push(clone(def.logic.rules[0]!));
      expect(codes(validateStructure(def))).toEqual(expect.arrayContaining([
        'error:duplicate_id:/blocks/marketing_1/config/options/1/id',
        'error:duplicate_id:/logic/rules/1/id',
        'error:duplicate_id:/logic/rules/1/when/id',
        'error:duplicate_id:/logic/rules/1/when/children/0/id',
      ]));
    });
  });

  it('I3: keys are unique across fields and logic variables', () => {
    const def = definition();
    blockOf(def, ids.marketing, 'single_choice').key = id<S.FieldKey>('name');
    def.logic.variables.push({
      id: id<S.VariableId>('v1'), key: id<S.FieldKey>('consent'), name: 'Total', type: 'number',
      expr: { k: 'lit', value: { type: 'number', value: id<S.DecimalString>('1') } }, persist: false,
    });
    expect(codes(validateStructure(def))).toEqual(expect.arrayContaining([
      'error:duplicate_key:/blocks/marketing_1/key',
      'error:duplicate_key:/logic/variables/0/key',
    ]));
  });

  describe('I4 references', () => {
    it('are draft warnings and publish errors', () => {
      const def = definition();
      def.logic.rules[0]!.then = [{ type: 'show', targets: [id<S.BlockId>('gone')] }];
      expect(codes(validateStructure(def))).toEqual(['warning:dangling_ref:/logic/rules/0/then/0/targets/0']);
      expect(codes(validateStructure(def, { mode: 'publish' }))).toEqual(['error:dangling_ref:/logic/rules/0/then/0/targets/0']);
    });

    it('cover answers, options, endings and purposes', () => {
      const def = definition();
      def.defaultEndingId = id<S.EndingId>('nope');
      def.logic.rules[0]!.when.children = [{
        kind: 'condition', id: ids.cond, op: 'includes_any',
        left: { kind: 'ref', ref: { kind: 'answer', blockId: id<S.BlockId>('missing') } },
        right: { kind: 'options', blockId: ids.marketing, optionIds: [id<S.OptionId>('maybe')] },
      }];
      blockOf(def, ids.name, 'short_text').compliance.purposeIds = [id<S.PurposeId>('unknown')];
      expect(codes(validateStructure(def, { mode: 'publish' }))).toEqual(expect.arrayContaining([
        'error:dangling_ref:/defaultEndingId',
        'error:dangling_ref:/logic/rules/0/when/children/0/left/ref/blockId',
        'error:dangling_ref:/logic/rules/0/when/children/0/right/optionIds/0',
        'error:dangling_ref:/blocks/name_1/compliance/purposeIds/0',
      ]));
    });
  });

  describe('I12 placement', () => {
    it('places each block once', () => {
      const def = definition();
      def.pages[0]!.children.push(ids.heading);
      expect(codes(validateStructure(def))).toContain('error:duplicate_id:/blocks/section_1/config/children/0');
    });

    it('rejects repeated children and warns about unplaced blocks', () => {
      const def = definition();
      def.pages[0]!.children = [ids.consent, ids.consent];
      expect(codes(validateStructure(def))).toEqual(expect.arrayContaining([
        'error:duplicate_id:/pages/0/children/1',
        'warning:dangling_ref:/blocks/name_1',
      ]));
    });

    it('walks pages in rendered order, nested children before the next sibling', () => {
      const def = definition();
      def.pages = [{ id: ids.page1, children: [ids.section, ids.marketing, ids.consent, ids.name] }];
      expect(codes(validateStructure(def))).toEqual([
        'error:duplicate_id:/pages/0/children/1',
        'warning:consent_after_consent_fields:/blocks/marketing_1',
      ]);
      expect(validateStructure(def)[0]?.message).toContain('/blocks/section_1/config/children/1');
    });
  });

  describe('unsupported blocks', () => {
    const withUnsupported = () => {
      const def = definition();
      const raw = { id: 'zz', type: 'future', body: { type: 'doc', content: [{ type: 'script' }] }, target: { kind: 'answer', blockId: 'gone' } };
      def.blocks[id<S.BlockId>('zz')] = { id: id<S.BlockId>('zz'), type: 'unsupported', originalType: 'future', raw };
      def.pages[0]!.children.push(id<S.BlockId>('zz'));
      def.x = { 'x-vendor': { type: 'doc', content: [{ type: 'script' }], ref: { kind: 'answer', blockId: 'gone' } } };
      return def;
    };

    it('warn while editing and block publishing', () => {
      expect(codes(validateStructure(withUnsupported()))).toEqual(['warning:unknown_block_type:/blocks/zz']);
      expect(codes(validateStructure(withUnsupported(), { mode: 'publish' }))).toEqual(['error:unknown_block_type:/blocks/zz']);
    });

    it('raw payloads and x- extensions are opaque', () => {
      const issues = validateStructure(withUnsupported());
      expect(issues.filter((i) => i.path.includes('/raw') || i.path.startsWith('/x'))).toEqual([]);
    });
  });

  describe('I5/I6 rich text', () => {
    it('only allows https, http, mailto and tel links', () => {
      const def = definition();
      def.description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: id<S.SafeHref>('javascript:alert(1)') } }] }] }] };
      expect(codes(validateStructure(def))).toEqual(['error:invalid_url_scheme:/description/content/0/content/0/marks/0/attrs/href']);
    });

    it('keeps inline docs to one paragraph', () => {
      const def = definition();
      const label = inline('a');
      (label.content as unknown as unknown[]).push({ type: 'paragraph' });
      blockOf(def, ids.name, 'short_text').label = label;
      expect(codes(validateStructure(def))).toEqual(['error:invalid_rich_text:/blocks/name_1/label']);
    });

    it('rejects unknown nodes and nesting past the limits', () => {
      const def = definition();
      let list: unknown = { type: 'paragraph' };
      for (let i = 0; i < 4; i += 1) list = { type: 'bulletList', content: [{ type: 'listItem', content: [list] }] };
      def.description = { type: 'doc', content: [list] } as S.RichDoc;
      def.endings[0] = { ...def.endings[0]!, content: { type: 'doc', content: [{ type: 'script' }] } as unknown as S.RichDoc } as S.Ending;
      expect(codes(validateStructure(def)).sort()).toEqual(['error:invalid_rich_text:/description', 'error:invalid_rich_text:/endings/0/content']);
    });

    it('needs alt text on content images', () => {
      const def = definition();
      def.description = { type: 'doc', content: [
        { type: 'image', attrs: { asset: { assetId: id<S.AssetId>('a1') } } },
        { type: 'image', attrs: { asset: { assetId: id<S.AssetId>('a2'), decorative: true } } },
      ] };
      expect(codes(validateStructure(def))).toEqual(['warning:missing_alt_text:/description/content/0/attrs/asset']);
    });
  });

  it('I7: classified fields need a purpose', () => {
    const def = definition();
    blockOf(def, ids.name, 'short_text').compliance.purposeIds = [];
    expect(codes(validateStructure(def, { mode: 'publish' }))).toEqual(['error:missing_purpose:/blocks/name_1/compliance/purposeIds']);
  });

  it('I7: value blocks without compliance are rejected', () => {
    const def = definition();
    delete (blockOf(def, ids.name, 'short_text') as Partial<S.BlockOf<'short_text'>>).compliance;
    expect(codes(validateStructure(def))).toEqual(['error:missing_purpose:/blocks/name_1/compliance']);
  });

  it('I14: a consent-based field may not come before the dpdp consent block', () => {
    const def = definition();
    blockOf(def, ids.section, 'section').config.children = [ids.heading];
    def.pages[0]!.children = [ids.marketing, ids.consent, ids.name];
    expect(codes(validateStructure(def, { mode: 'publish' }))).toEqual(['error:consent_after_consent_fields:/blocks/marketing_1']);
  });

  it('I14: a consent-based field nested in an earlier section comes before the consent block', () => {
    const def = definition();
    def.pages = [{ id: ids.page1, children: [ids.section, ids.consent, ids.name] }];
    expect(codes(validateStructure(def, { mode: 'publish' }))).toEqual(['error:consent_after_consent_fields:/blocks/marketing_1']);
  });

  it('I14: a consent block nested in an earlier section comes first', () => {
    const def = definition();
    blockOf(def, ids.section, 'section').config.children = [ids.heading, ids.consent];
    def.pages = [{ id: ids.page1, children: [ids.section, ids.marketing, ids.name] }];
    expect(validateStructure(def, { mode: 'publish' })).toEqual([]);
  });
});
