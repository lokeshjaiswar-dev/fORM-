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

    it('holds translations of inline sources to one paragraph (BL-025)', () => {
      const def = definition();
      const twoParagraphs = { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] } as unknown as S.InlineDoc;
      const entry = (value: S.TranslationEntry['value']): S.TranslationEntry => ({ value, sourceHash: id<S.Sha256Hex>('a'.repeat(64)), origin: 'human' });
      def.i18n.messages = {
        [id<S.Locale>('hi-IN')]: {
          [`block:${ids.name}:label`]: entry(twoParagraphs),
          [`consent:${ids.consent}:item:${ids.item}`]: entry(inline('समाचार पत्र भेजें')),
          'form:description': entry(twoParagraphs),
        },
      };
      expect(codes(validateStructure(def))).toEqual([`error:invalid_rich_text:/i18n/messages/hi-IN/block:${ids.name}:label/value`]);
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

  describe('S6 redirect and visit_url targets', () => {
    const redirectTo = (...url: S.PlainTemplate): S.FormDefinition => {
      const def = definition();
      def.endings.push({ id: id<S.EndingId>('ending_go'), kind: 'redirect', name: 'Go', url });
      return def;
    };
    const pipe = (): S.PlainTemplate[number] => ({ pipe: { source: { kind: 'answer', blockId: ids.name }, encode: 'url' } });
    const WHERE = '/endings/1/url';

    it.each([
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a javascript: URL in mixed case after a space', ' JaVaScRiPt:alert(1)'],
      ['a bare scheme with a leading space', ' JaVaScRiPt:'],
      ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
      ['a protocol-relative URL', '//evil.example'],
      ['a scheme with a tab inside', 'java\tscript:alert(1)'],
      ['an https URL with a leading space', ' https://x.example'],
      ['a scheme that is only half there', 'https:/x.example'],
      ['a relative path', '/thanks'],
      ['ftp', 'ftp://x.example/file'],
    ])('rejects %s in a redirect ending', (_name, url) => {
      expect(codes(validateStructure(redirectTo(url)))).toEqual([`error:invalid_url_scheme:${WHERE}`]);
      expect(codes(validateStructure(redirectTo(url), { mode: 'publish' }))).toEqual([`error:invalid_url_scheme:${WHERE}`]);
    });

    it('accepts https and http URLs, in any case, with answers piped after the literal prefix', () => {
      for (const url of [['https://x.example/thanks'], ['http://x.example'], ['HTTPS://X.EXAMPLE'], ['https://x.example/', pipe()], ['https://x.example/?ref=', pipe(), '&v=1']]) {
        expect(validateStructure(redirectTo(...(url as S.PlainTemplate)), { mode: 'publish' })).toEqual([]);
      }
    });

    it('reads the literal prefix across consecutive strings, and stops it at the first pipe', () => {
      expect(validateStructure(redirectTo('ht', 'tps://', 'x.example/thanks'), { mode: 'publish' })).toEqual([]);
      expect(codes(validateStructure(redirectTo(pipe(), 'https://x.example')))).toEqual([`error:invalid_url_scheme:${WHERE}`]);
      expect(codes(validateStructure(redirectTo('java', pipe(), 'script:alert(1)')))).toEqual([`error:invalid_url_scheme:${WHERE}`]);
    });

    it('refuses control characters anywhere in the literal text, even after a valid prefix', () => {
      for (const bad of ['https://x.example/\nSet-Cookie: a=b', 'https://x.example/\u0000', 'https://x.example/\u007f', 'https://x.example/\u0085']) {
        expect(codes(validateStructure(redirectTo(bad)))).toEqual([`error:invalid_url_scheme:${WHERE}`]);
      }
      expect(codes(validateStructure(redirectTo('https://x.example/', pipe(), '\r\n')))).toEqual([`error:invalid_url_scheme:${WHERE}`]);
    });

    it('lets a draft hold an empty URL, and refuses it at publish', () => {
      expect(codes(validateStructure(redirectTo()))).toEqual([`warning:invalid_url_scheme:${WHERE}`]);
      expect(codes(validateStructure(redirectTo(''), { mode: 'publish' }))).toEqual([`error:invalid_url_scheme:${WHERE}`]);
    });

    it('checks visit_url actions of a message ending at their own path', () => {
      const def = definition();
      const ending = def.endings[0] as Extract<S.Ending, { kind: 'message' }>;
      ending.actions = [
        { kind: 'visit_url', label: 'Ok', url: ['https://x.example'] },
        { kind: 'visit_url', label: 'Bad', url: ['javascript:alert(1)'] },
        { kind: 'visit_url', label: 'Piped first', url: [pipe(), 'https://x.example'] },
      ];
      expect(codes(validateStructure(def))).toEqual([
        'error:invalid_url_scheme:/endings/0/actions/1/url',
        'error:invalid_url_scheme:/endings/0/actions/2/url',
      ]);
    });

    it('checks a translated ending URL like the source URL, so a locale cannot swap in a script URL', () => {
      const def = redirectTo('https://x.example');
      const entry = (value: S.TranslationEntry['value']): S.TranslationEntry => ({ value, sourceHash: id<S.Sha256Hex>('a'.repeat(64)), origin: 'human' });
      def.i18n.messages = {
        [id<S.Locale>('hi-IN')]: {
          'ending:ending_go:url': entry(['javascript:alert(1)']),
          'ending:ending_go:content': entry(inline('यहाँ जाएँ')),
        },
        [id<S.Locale>('ta-IN')]: { 'ending:ending_go:url': entry('https://x.example/ta') },
        [id<S.Locale>('bn-IN')]: { 'ending:ending_go:url': entry('data:text/html,x') },
        [id<S.Locale>('mr-IN')]: { 'ending:ending_go:url': entry(inline('https://x.example')) },
      };
      expect(codes(validateStructure(def))).toEqual([
        'error:invalid_url_scheme:/i18n/messages/hi-IN/ending:ending_go:url/value',
        'error:invalid_url_scheme:/i18n/messages/bn-IN/ending:ending_go:url/value',
        'error:invalid_url_scheme:/i18n/messages/mr-IN/ending:ending_go:url/value',
      ]);
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

  describe('Step 0 denylist: no credentials in a request the browser sends (review B1)', () => {
    const url = 'https://hr.example/api/employees' as S.SafeUrl;
    const bearer: S.ApiAuth = { type: 'bearer', token: 'HR-SECRET-TOKEN' };

    it('a form-level lookup with credentials warns in a draft and is refused at publish', () => {
      const def = definition();
      def.lookups = [{ id: 'hr', url, auth: bearer }, { id: 'open', url }];
      def.lookup = { url, auth: { type: 'basic', username: 'u', password: 'p' } };
      expect(FormDefinitionSchema.safeParse(def).success).toBe(true);
      expect(codes(validateStructure(def))).toEqual(['warning:browser_credentials:/lookup/auth', 'warning:browser_credentials:/lookups/0/auth']);
      expect(codes(validateStructure(def, { mode: 'publish' }))).toEqual(['error:browser_credentials:/lookup/auth', 'error:browser_credentials:/lookups/0/auth']);
    });

    it('API options and API checks with credentials are refused at publish', () => {
      const def = definition();
      blockOf(def, ids.marketing, 'single_choice').apiOptions = { url, auth: { type: 'api_key', header: 'X-Key', value: 'k' } };
      blockOf(def, ids.name, 'short_text').apiValidation = { url, auth: bearer };
      expect(codes(validateStructure(def, { mode: 'publish' })).sort()).toEqual([
        `error:browser_credentials:/blocks/${ids.marketing}/apiOptions/auth`,
        `error:browser_credentials:/blocks/${ids.name}/apiValidation/auth`,
      ].sort());
      delete blockOf(def, ids.marketing, 'single_choice').apiOptions!.auth;
      delete blockOf(def, ids.name, 'short_text').apiValidation!.auth;
      expect(validateStructure(def, { mode: 'publish' })).toEqual([]);
    });
  });

  describe('dependent options', () => {
    const child = id<S.BlockId>('channel_1');
    /** A second choice after "Send updates?" whose options follow its answer: Email only for Yes, Never always. */
    const withChild = (place: 'after' | 'before' = 'after') => {
      const def = definition();
      const parent = blockOf(def, ids.marketing, 'single_choice');
      def.blocks[child] = {
        ...clone(parent),
        id: child,
        key: id<S.FieldKey>('channel'),
        config: {
          display: 'dropdown',
          dependsOn: ids.marketing,
          options: [
            { id: id<S.OptionId>('email'), label: 'Email', parentOptionIds: [ids.yes] },
            { id: id<S.OptionId>('never'), label: 'Never' },
          ],
        },
      };
      const section = blockOf(def, ids.section, 'section');
      section.config.children = place === 'after' ? [...section.config.children, child] : [child, ...section.config.children];
      return def;
    };

    it('accepts a child placed after its parent whose links name parent options', () => {
      const def = withChild();
      expect(FormDefinitionSchema.safeParse(def).success).toBe(true);
      expect(validateStructure(def, { mode: 'publish' })).toEqual([]);
    });

    it('refuses a link to an option the parent does not have', () => {
      const def = withChild();
      blockOf(def, child, 'single_choice').config.options[0]!.parentOptionIds = [id<S.OptionId>('maybe')];
      expect(codes(validateStructure(def, { mode: 'publish' }))).toContain('error:dangling_ref:/blocks/channel_1/config/options/0/parentOptionIds/0');
    });

    it('refuses a parent that is not a choice, or the block itself', () => {
      const def = withChild();
      blockOf(def, child, 'single_choice').config.dependsOn = ids.name;
      expect(codes(validateStructure(def, { mode: 'publish' }))).toContain('error:dangling_ref:/blocks/channel_1/config/dependsOn');
      blockOf(def, child, 'single_choice').config.dependsOn = child;
      expect(codes(validateStructure(def, { mode: 'publish' }))).toContain('error:dangling_ref:/blocks/channel_1/config/dependsOn');
    });

    it('refuses a parent placed after the child, so a chain can never loop', () => {
      expect(codes(validateStructure(withChild('before')))).toContain('error:page_order_violation:/blocks/channel_1/config/dependsOn');
    });

    /** Puts `members` inside a repeating group, in place of the section's children. */
    const inGroup = (def: S.FormDefinition, members: S.BlockId[]) => {
      const list = id<S.BlockId>('list_1');
      def.blocks[list] = {
        id: list, type: 'repeating_group', key: id<S.FieldKey>('items'), label: inline('Items'), required: false,
        compliance: { ...blockOf(def, ids.name, 'short_text').compliance, classification: 'none', purposeIds: [] },
        config: { children: members, minRows: 1, maxRows: 10, layout: 'stacked' },
      };
      const section = blockOf(def, ids.section, 'section');
      section.config.children = [...section.config.children.filter((c) => !members.includes(c)), list];
    };

    it('refuses dependent options inside a repeating group, for the child or the parent (review S3)', () => {
      const both = withChild();
      inGroup(both, [ids.marketing, child]);
      expect(FormDefinitionSchema.safeParse(both).success).toBe(true);
      expect(codes(validateStructure(both))).toEqual(['warning:missing_capability:/blocks/channel_1/config/dependsOn']);
      expect(codes(validateStructure(both, { mode: 'publish' }))).toEqual(['error:missing_capability:/blocks/channel_1/config/dependsOn']);
      const parentInGroup = withChild();
      inGroup(parentInGroup, [ids.marketing]);
      expect(codes(validateStructure(parentInGroup, { mode: 'publish' }))).toEqual(['error:missing_capability:/blocks/channel_1/config/dependsOn']);
      const childInGroup = withChild();
      inGroup(childInGroup, [child]);
      expect(codes(validateStructure(childInGroup, { mode: 'publish' }))).toEqual(['error:missing_capability:/blocks/channel_1/config/dependsOn']);
    });

    it('refuses options that both load from an API and depend on another question at publish (review N6)', () => {
      const def = withChild();
      blockOf(def, child, 'single_choice').apiOptions = { url: 'https://api.example.com/channels' as S.SafeUrl };
      expect(codes(validateStructure(def, { mode: 'publish' }))).toEqual(['error:dangling_ref:/blocks/channel_1/apiOptions']);
    });
  });
});
