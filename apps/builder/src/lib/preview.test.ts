import { describe, expect, it } from 'vitest';
import { REGISTRY } from '@form/registry';
import type { IsoInstant } from '@form/schema';
import { previewStatus, previewUploader, previewVersion } from '@/lib/preview';
import { defaultOps } from '@/state/opsStore';
import { richDoc } from '@/lib/definition';
import { block, formWith } from '@/test/fixtures';

const NOW = '2026-10-19T04:30:00Z' as IsoInstant;

describe('preview pipeline', () => {
  it('turns the local FormOps into runtime statuses; the password never enters the definition (S5)', () => {
    expect(previewStatus(defaultOps())).toEqual({ state: 'open' });
    expect(previewStatus({ ...defaultOps(), open: false, closedMessage: richDoc('See you next year') })).toMatchObject({ state: 'closed', screen: richDoc('See you next year') });
    expect(previewStatus({ ...defaultOps(), password: 'hunter2' }).state).toBe('password');
  });

  it('compiles and projects the v2 draft for the runtime, or reports why the engine refuses it', () => {
    const definition = formWith([block('short_text', 'name', { label: 'Name' })]);
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
    expect(ref.fileId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
