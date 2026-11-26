import { describe, expect, it } from 'vitest';
import type { IsoInstant } from '@form/schema';
import { decodeShareFragment, encodeShareFragment, shareOrigin } from '@/lib/shareLink';
import { block, doc, resetStore } from '@/test/fixtures';

const NOW = '2026-11-24T10:00:00Z' as IsoInstant;

describe('preview links', () => {
  it('carry the whole form and read it back, checked like an imported file', async () => {
    resetStore([block('short_text', 'name', { label: 'Your name' }), block('single_choice', 'country', { label: 'Country' })]);
    const fragment = await encodeShareFragment(doc());
    expect(fragment).toMatch(/^#form=[A-Za-z0-9_-]+$/);
    const opened = await decodeShareFragment(fragment, NOW);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(Object.keys(opened.doc.blocks).sort()).toEqual(Object.keys(doc().blocks).sort());
  });

  it('refuse a damaged or foreign link with a reason instead of throwing', async () => {
    expect(await decodeShareFragment('#form=not-gzip', NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/damaged/) });
    expect(await decodeShareFragment('#other', NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/does not contain a form/) });
  });

  it('use the network address when the builder is open on localhost, and the page address otherwise', () => {
    const local = { protocol: 'http:', hostname: '127.0.0.1', port: '5173', origin: 'http://127.0.0.1:5173' };
    expect(shareOrigin(local, ['192.168.0.48'])).toBe('http://192.168.0.48:5173');
    expect(shareOrigin(local, [])).toBe('http://127.0.0.1:5173');
    expect(shareOrigin({ protocol: 'https:', hostname: 'forms.example.com', port: '', origin: 'https://forms.example.com' }, ['10.0.0.2'])).toBe('https://forms.example.com');
  });
});
