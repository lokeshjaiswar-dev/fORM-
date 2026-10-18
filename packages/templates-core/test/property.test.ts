import { validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { canonicalJson, validateStructure } from '@form/schema';
import type * as S from '@form/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyDocumentOps, insertSnippet, instantiate, isUuid } from '../src/index.ts';
import { conditionIds } from '../src/shared.ts';
import { context, kycSnippet, versionOf } from './build.ts';
import { KINDS, build, type RandomSpec } from './random.ts';

/*
 * Templates spec §10.2 (WP-T0.2): instances validate, no dangling references, deterministic ids, disjoint ids
 * for different seeds, over random form templates (pages, sections, choice options, rules, translations,
 * optional parts and prompt variables).
 */

const KIND = fc.constantFrom(...KINDS);
const spec: fc.Arbitrary<RandomSpec> = fc.record({
  blocks: fc.array(KIND, { minLength: 2, maxLength: 12 }),
  pageBreaks: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
  sectionAt: fc.option(fc.nat(11), { nil: undefined }),
  rules: fc.array(fc.record({ from: fc.nat(11), to: fc.nat(11), action: fc.constantFrom('show', 'hide', 'require', 'disable') }), { maxLength: 6 }),
  part: fc.record({ blocks: fc.uniqueArray(fc.nat(11), { maxLength: 3 }), rules: fc.uniqueArray(fc.nat(5), { maxLength: 2 }), on: fc.boolean() }),
  translate: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
});

const errors = (def: S.FormDefinition) => validateDefinition(def, 'save', REGISTRY).filter((i) => i.severity === 'error');
const dangling = (def: S.FormDefinition) => validateStructure(def, { mode: 'publish' }).filter((i) => i.code === 'dangling_ref');
/* Every remapped id: elements, rules, rule groups, logic variables, purposes and conditions. */
const elementIds = (def: S.FormDefinition) => [
  ...Object.keys(def.blocks), ...def.pages.map((p) => p.id), ...def.endings.map((e) => e.id), ...def.logic.rules.map((r) => r.id), ...def.logic.ruleGroups.map((g) => g.id),
  ...def.logic.variables.map((v) => v.id), ...def.privacy.purposes.map((p) => p.id), ...conditionIds(def.logic),
];
const seed = fc.string({ minLength: 1, maxLength: 40 });

describe('instantiate properties', () => {
  it('instances validate, keep no dangling reference, are deterministic and use disjoint ids per seed', () => {
    fc.assert(fc.property(spec, seed, seed, fc.boolean(), fc.option(fc.string({ maxLength: 12 }), { nil: undefined }), (s, seedA, seedB, part, title) => {
      fc.pre(seedA !== seedB);
      const payload = build(s);
      fc.pre(errors(payload.document).length === 0 && dangling(payload.document).length === 0);
      const variables: S.InstantiateContext['variables'] = title === undefined ? { 'custom.part': part } : { 'custom.part': part, 'custom.title': title };
      const a = instantiate(versionOf(payload), context({ idSeed: seedA, variables }));
      expect(errors(a.definition)).toEqual([]);
      expect(dangling(a.definition)).toEqual([]);
      expect(elementIds(a.definition).every(isUuid)).toBe(true);
      expect(canonicalJson(instantiate(versionOf(payload), context({ idSeed: seedA, variables })))).toBe(canonicalJson(a));
      const b = instantiate(versionOf(payload), context({ idSeed: seedB, variables }));
      const mine = new Set(elementIds(a.definition));
      expect(elementIds(b.definition).filter((x) => mine.has(x))).toEqual([]);
      expect(Object.keys(a.definition.blocks).length).toBe(Object.keys(b.definition.blocks).length);
    }), { numRuns: 150 });
  });

  it('snippet insertion into random instances keeps the draft valid', () => {
    fc.assert(fc.property(spec, seed, fc.nat(), (s, snippetSeed, at) => {
      const payload = build(s);
      fc.pre(errors(payload.document).length === 0);
      const def = instantiate(versionOf(payload), context()).definition;
      const target = def.pages[at % def.pages.length];
      if (!target) return;
      const { newFormId: _n, include: _i, ...ctx } = context({ idSeed: snippetSeed });
      const after = target.children[at % Math.max(1, target.children.length)];
      const r = insertSnippet(versionOf(kycSnippet()), def, after === undefined ? { pageId: target.id } : { pageId: target.id, afterBlockId: after }, ctx);
      const next = applyDocumentOps(def, r.ops);
      expect(errors(next)).toEqual([]);
      expect(dangling(next)).toEqual([]);
      const keys = Object.values(next.blocks).flatMap((b) => (b && 'key' in b ? [b.key] : []));
      expect(new Set(keys).size).toBe(keys.length);
    }), { numRuns: 100 });
  });
});
