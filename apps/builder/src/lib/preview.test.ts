import { describe, expect, it } from 'vitest';
import { REGISTRY } from '@form/registry';
import type { IsoInstant } from '@form/schema';
import { block, formWith } from '@/test/fixtures';
import { previewDraft, previewUploader, previewVersion } from '@/lib/preview';

const NOW = '2026-10-19T04:30:00Z' as IsoInstant;

describe('preview pipeline', () => {
  it('migrates the store document the same way every time, so ids stay stable while the author edits', () => {
    const form = formWith([block('text', { id: 'name', label: 'Name' }), block('page_break', { id: 'pb' }), block('email', { id: 'mail', label: 'Email' })]);
    const a = previewDraft(form, NOW);
    const b = previewDraft(form, NOW);
    expect(a).toEqual(b);
    expect(a.definition.pages.map((p) => p.children)).toEqual([['name'], ['mail']]);
    expect(a.status).toEqual({ state: 'open' });
  });

  it('turns the v1 closed flag and password into runtime statuses; the password never enters the definition (S5)', () => {
    const closed = formWith([block('text', { id: 'name' })]);
    closed.settings = { ...closed.settings, closed: true, closedMessage: 'See you next year' };
    expect(previewDraft(closed, NOW).status).toMatchObject({ state: 'closed', screen: { content: [{ type: 'paragraph', content: [{ text: 'See you next year' }] }] } });

    const locked = formWith([block('text', { id: 'name' })]);
    locked.settings = { ...locked.settings, password: 'hunter2' };
    const draft = previewDraft(locked, NOW);
    expect(draft.status.state).toBe('password');
    expect(draft.password).toBe('hunter2');
    expect(JSON.stringify(draft.definition)).not.toContain('hunter2');
  });

  it('compiles and projects for the runtime, or reports why the engine refuses the draft', () => {
    const { definition } = previewDraft(formWith([block('text', { id: 'name', label: 'Name' })]), NOW);
    const ok = previewVersion(definition, { state: 'open' }, NOW);
    expect(ok.ok && ok.version.compiled.engine).toBe('logic@2');
    expect(ok.ok && ok.version.definition.blocks['name' as never]).toBeDefined();

    const image = { id: 'grid', type: 'image', config: REGISTRY.image.defaultConfig('en-IN' as never) } as never;
    const broken = { ...definition, blocks: { ...definition.blocks, grid: image }, pages: [{ ...definition.pages[0]!, children: [...definition.pages[0]!.children, 'grid' as never] }] };
    const refused = previewVersion(broken, { state: 'open' }, NOW);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.issues.length).toBeGreaterThan(0);
  });

  it('keeps preview files in the page, with their real SHA-256', async () => {
    const ref = await previewUploader({ blockId: 'f' as never, purpose: 'file', file: new Blob(['abc'], { type: 'text/plain' }), name: 'a.txt' });
    expect(ref).toMatchObject({ name: 'a.txt', sizeBytes: 3, mime: 'text/plain', scan: 'skipped', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
  });
});
