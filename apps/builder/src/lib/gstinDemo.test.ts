import { describe, expect, it } from 'vitest';
import { compile } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { gstinDemoDefinition } from '@/lib/gstinDemo';
import { counter } from '@/test/fixtures';

describe('gstinDemoDefinition', () => {
  it('compiles a State + GSTIN form with a block-submit check', () => {
    const def = gstinDemoDefinition('demo', counter('demo'));
    expect(def.title).toBe('Demo: GSTIN vs State');
    const types = def.pages[0]?.children.map((id) => def.blocks[id]?.type);
    expect(types).toEqual(['heading', 'paragraph', 'single_choice', 'short_text']);
    const rule = def.logic.rules[0];
    expect(rule?.then[0]).toMatchObject({ type: 'block_submit' });
    expect(compile(def, REGISTRY).ok).toBe(true);
  });
});
