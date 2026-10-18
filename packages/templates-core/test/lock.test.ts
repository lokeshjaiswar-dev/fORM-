import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { TemplateCoreError, instantiate, lockFingerprint, opsLockFingerprint } from '../src/index.ts';
import { context, eventPayload, id, inline, versionOf } from './build.ts';

const payload = eventPayload();
const { definition, bindings, ops } = instantiate(versionOf(payload), context());
const [form] = bindings;
if (!form) throw new Error('no form binding');
/** The payload's own fingerprints are taken with an empty id map (TemplateVersion.lockFingerprints at publish). */
const identity: S.FormTemplateBinding = { ...form, idMap: {}, keyMap: {} };
const lock = (target: S.LockSpec['target'], modes: S.LockMode[] = ['content']): S.LockSpec => ({ id: id('lock'), target, modes, reason: 'test' });
const kycLock = lock({ kind: 'block', sourceId: 'kyc' }, ['content', 'structure', 'presence']);
const blockId = (sourceId: string) => form.idMap[sourceId] as S.BlockId;

describe('lockFingerprint', () => {
  it('is the same for the template payload and a fresh instance (ids and keys mapped back)', () => {
    for (const l of payload.locks) expect(lockFingerprint(definition, form, l)).toBe(lockFingerprint(payload.document, identity, l));
    expect(lockFingerprint(definition, form, kycLock)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when locked content changes, and only then', () => {
    const before = lockFingerprint(definition, form, kycLock);
    const pan = definition.blocks[blockId('pan_number')];
    if (pan?.type !== 'short_text') throw new Error('fixture drifted');
    const relabelled = { ...definition, blocks: { ...definition.blocks, [pan.id]: { ...pan, label: inline('Permanent account number') } } };
    expect(lockFingerprint(relabelled, form, kycLock)).not.toBe(before);
    const required = { ...definition, blocks: { ...definition.blocks, [pan.id]: { ...pan, required: true } } };
    expect(lockFingerprint(required, form, kycLock)).not.toBe(before);
    const styled = { ...definition, blocks: { ...definition.blocks, [pan.id]: { ...pan, layout: { width: 'half' as const } } } };
    expect(lockFingerprint(styled, form, kycLock)).toBe(before);
    const name = definition.blocks[blockId('name')];
    if (name?.type !== 'short_text') throw new Error('fixture drifted');
    const other = { ...definition, blocks: { ...definition.blocks, [name.id]: { ...name, label: inline('Anything') } } };
    expect(lockFingerprint(other, form, kycLock)).toBe(before);
  });

  it('sees moves (structure) and deletion or hiding (presence)', () => {
    const before = lockFingerprint(definition, form, kycLock);
    const moved = { ...definition, pages: definition.pages.map((p, i) => ({ ...p, children: i === 0 ? [...p.children, blockId('kyc')] : p.children.filter((c) => c !== blockId('kyc')) })) };
    expect(lockFingerprint(moved, form, lock({ kind: 'block', sourceId: 'kyc' }, ['structure']))).not.toBe(lockFingerprint(definition, form, lock({ kind: 'block', sourceId: 'kyc' }, ['structure'])));
    const { [blockId('kyc')]: _gone, ...blocks } = definition.blocks;
    expect(lockFingerprint({ ...definition, blocks }, form, kycLock)).not.toBe(before);
    const kyc = definition.blocks[blockId('kyc')];
    if (kyc?.type !== 'section') throw new Error('fixture drifted');
    const hidden = { ...definition, blocks: { ...definition.blocks, [kyc.id]: { ...kyc, initiallyHidden: true } } };
    expect(lockFingerprint(hidden, form, lock({ kind: 'block', sourceId: 'kyc' }, ['presence']))).not.toBe(lockFingerprint(definition, form, lock({ kind: 'block', sourceId: 'kyc' }, ['presence'])));
  });

  it('ignores what a live variable resolves to, not which variable it is', () => {
    const intro = lock({ kind: 'block', sourceId: 'intro' });
    const heading = definition.blocks[blockId('intro')];
    if (heading?.type !== 'heading') throw new Error('fixture drifted');
    const withFallback = { ...heading, config: { ...heading.config, subheading: inline('Hosted by ', { type: 'var', attrs: { name: 'org.legal_name', fallback: 'us' } }) } };
    expect(lockFingerprint({ ...definition, blocks: { ...definition.blocks, [heading.id]: withFallback } }, form, intro)).toBe(lockFingerprint(definition, form, intro));
    const otherVar = { ...heading, config: { ...heading.config, subheading: inline('Hosted by ', { type: 'var', attrs: { name: 'org.display_name' } }) } };
    expect(lockFingerprint({ ...definition, blocks: { ...definition.blocks, [heading.id]: otherVar } }, form, intro)).not.toBe(lockFingerprint(definition, form, intro));
  });

  it('fingerprints theme tokens, endings and purposes', () => {
    const theme = lock({ kind: 'theme', tokens: ['colors.accent', 'radius', 'logo'] });
    const t = lockFingerprint(definition, form, theme);
    expect(lockFingerprint({ ...definition, theme: { ...definition.theme, tokens: { ...definition.theme.tokens, radius: 'none' } } }, form, theme)).not.toBe(t);
    expect(lockFingerprint({ ...definition, theme: { ...definition.theme, tokens: { ...definition.theme.tokens, density: 'compact' } } }, form, theme)).toBe(t);

    /* The ending's text holds a baked prompt variable, so only its presence matches the payload's fingerprint. */
    const present = lock({ kind: 'ending', sourceId: 'ending_1' }, ['presence']);
    expect(lockFingerprint(definition, form, present)).toBe(lockFingerprint(payload.document, identity, present));
    expect(lockFingerprint({ ...definition, endings: definition.endings.slice(1) }, form, present)).not.toBe(lockFingerprint(definition, form, present));
    const ending = lock({ kind: 'ending', sourceId: 'ending_1' }, ['content', 'presence']);
    expect(lockFingerprint(definition, form, ending)).not.toBe(lockFingerprint(payload.document, identity, ending));
    const [first, ...rest] = definition.endings;
    if (first?.kind !== 'message') throw new Error('fixture drifted');
    expect(lockFingerprint({ ...definition, endings: [{ ...first, name: 'Renamed' }, ...rest] }, form, ending)).toBe(lockFingerprint(definition, form, ending));
    expect(lockFingerprint({ ...definition, endings: [{ ...first, confetti: true }, ...rest] }, form, ending)).not.toBe(lockFingerprint(definition, form, ending));

    const purpose = payload.locks.find((l) => l.target.kind === 'purpose');
    if (!purpose) throw new Error('fixture drifted');
    const renamed = { ...definition, privacy: { ...definition.privacy, purposes: definition.privacy.purposes.map((p) => ({ ...p, name: `${p.name}!` })) } };
    expect(lockFingerprint(renamed, form, purpose)).not.toBe(lockFingerprint(definition, form, purpose));
  });

  it('sends email and PDF locks to opsLockFingerprint, and back', () => {
    const emailBinding = bindings.find((b) => b.kind === 'email');
    const pdfBinding = bindings.find((b) => b.kind === 'pdf');
    if (!emailBinding || !pdfBinding) throw new Error('fixture drifted');
    const email = lock({ kind: 'email', sourceId: '$root', parts: ['subject', 'footer'] });
    expect(() => lockFingerprint(definition, form, email)).toThrow(TemplateCoreError);
    const e = opsLockFingerprint(ops, emailBinding, email);
    const changed = { ...ops, notifications: ops.notifications.map((n) => ({ ...n, subject: ['Changed'] })) };
    expect(opsLockFingerprint(changed, emailBinding, email)).not.toBe(e);
    const pdf = lock({ kind: 'pdf', sourceId: '$root', parts: ['footer'] });
    const p = opsLockFingerprint(ops, pdfBinding, pdf);
    expect(opsLockFingerprint({ ...ops, pdfTemplates: [] }, pdfBinding, pdf)).not.toBe(p);
    expect(() => opsLockFingerprint(ops, form, kycLock)).toThrow(TemplateCoreError);
  });
});
