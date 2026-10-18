import { REGISTRY } from '@form/registry';
import { sha256Jcs } from '@form/schema';
import type { BlockId, BlockOf, BlockType, FormDefinition, FormOps, FormTemplateBinding, LockFingerprint, LockSpec, Sha256Hex, StoredBlock } from '@form/schema';
import { TemplateCoreError } from './errors.ts';
import { inverseRemapOf, isOpaque, isRec, remapOf, remapRefs, type Rec, type Remap } from './remap.ts';
import { ROOT_SOURCE_ID } from './shared.ts';

/** Lock fingerprint format; part of every hash, so a projection change is a new version, never a silent one. */
export const LOCK_FINGERPRINT_VERSION = 1;

/** `live` variables are normalised to their names (templates spec §3.4): what they resolve to never changes a fingerprint. */
function normaliseVars(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseVars);
  if (!isRec(value)) return value;
  if (value['type'] === 'var' && isRec(value['attrs'])) return { type: 'var', attrs: { name: value['attrs']['name'] } };
  if (Object.keys(value).length === 1 && isRec(value['var'])) return { var: { name: value['var']['name'] } };
  const out: Rec = {};
  for (const [k, v] of Object.entries(value)) out[k] = isOpaque(value, k) ? v : normaliseVars(v);
  return out;
}

/** JSON pointer read (`/config/options`). */
function at(value: unknown, pointer: string): unknown {
  let node = value;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = isRec(node) || Array.isArray(node) ? (node as Rec)[key] : undefined;
  }
  return node;
}

const childrenOf = (block: StoredBlock | undefined): readonly BlockId[] =>
  block && (block.type === 'section' || block.type === 'repeating_group') ? block.config.children : [];

/** Content-mode paths of a block: the registry's `lockableContent` plus the required flag of value fields. */
function contentPaths(block: StoredBlock): string[] {
  if (block.type === 'unsupported') return ['/raw'];
  const paths = (REGISTRY[block.type] as { lockableContent(b: BlockOf<BlockType>): string[] }).lockableContent(block as BlockOf<BlockType>);
  return 'required' in block ? [...paths, '/required'] : paths;
}

function parentOf(doc: FormDefinition, id: BlockId): string | null {
  const page = doc.pages.find((p) => p.children.includes(id));
  if (page) return page.id;
  const container = Object.values(doc.blocks).find((b) => childrenOf(b).includes(id));
  return container ? container.id : null;
}

function blockProjection(doc: FormDefinition, lock: LockSpec, sourceId: string, forward: Remap, back: Remap): unknown {
  const rootId = forward.id('element', sourceId) as BlockId;
  const root = doc.blocks[rootId];
  if (!root) return { present: false };
  const subtree: StoredBlock[] = [];
  const visit = (id: BlockId) => {
    const block = doc.blocks[id];
    if (!block || subtree.includes(block)) return;
    subtree.push(block);
    childrenOf(block).forEach(visit);
  };
  visit(rootId);
  const source = (id: string) => back.id('element', id);
  const out: Rec = {};
  if (lock.modes.includes('content')) {
    out['content'] = subtree.map((block) => ({ id: source(block.id), values: remapRefs(Object.fromEntries(contentPaths(block).map((p) => [p, at(block, p) ?? null])), back) }));
  }
  if (lock.modes.includes('structure')) {
    const parent = parentOf(doc, rootId);
    out['structure'] = { parent: parent === null ? null : source(parent), children: subtree.map((block) => ({ id: source(block.id), children: childrenOf(block).map(source) })) };
  }
  if (lock.modes.includes('presence')) out['presence'] = { present: true, initiallyHidden: root.type !== 'unsupported' && root.initiallyHidden === true };
  return out;
}

function tokenProjection(tokens: unknown, paths: readonly string[]): unknown {
  return Object.fromEntries([...paths].sort().map((p) => [p, at(tokens, `/${p.split('.').join('/')}`) ?? null]));
}

function hash(lock: LockSpec, projection: unknown): Sha256Hex {
  const modes = [...new Set(lock.modes)].sort();
  return sha256Jcs({ v: LOCK_FINGERPRINT_VERSION, target: lock.target, modes, projection: normaliseVars(projection) });
}

/**
 * `lockFingerprint(doc, binding, lock)` (templates spec §3.4, enforced from P3): SHA-256 over the JCS of the
 * locked projection, with instance ids and keys mapped back to the template's source ids and keys through the
 * binding, and `live` variable nodes reduced to their names. The fingerprint of a fresh instance therefore
 * equals the fingerprint of the template payload (taken with an empty `idMap`), unless the locked content holds
 * `bake` variables. Block, theme, ending and purpose locks read the definition; email and PDF locks live in
 * FormOps (`opsLockFingerprint`).
 */
export const lockFingerprint: LockFingerprint = (doc, binding, lock) => {
  const forward = remapOf(binding.idMap, binding.keyMap);
  const back = inverseRemapOf(binding.idMap, binding.keyMap);
  const target = lock.target;
  switch (target.kind) {
    case 'block':
      return hash(lock, blockProjection(doc, lock, target.sourceId, forward, back));
    case 'theme':
      return hash(lock, tokenProjection(doc.theme.tokens, target.tokens));
    case 'ending': {
      const ending = doc.endings.find((e) => e.id === forward.id('element', target.sourceId));
      if (!ending) return hash(lock, { present: false });
      const { id: _id, name: _name, origin: _origin, ...content } = ending;
      return hash(lock, remapRefs({ present: true, ...(lock.modes.includes('content') ? { content } : {}) }, back));
    }
    case 'purpose': {
      const purpose = doc.privacy.purposes.find((p) => p.id === forward.id('purpose', target.sourceId));
      if (!purpose) return hash(lock, { present: false });
      return hash(lock, remapRefs({ present: true, name: purpose.name, description: purpose.description, lawfulBasis: purpose.lawfulBasis }, back));
    }
    case 'email':
    case 'pdf':
      throw new TemplateCoreError('lock_target_in_ops', `${target.kind} locks are fingerprinted from FormOps: use opsLockFingerprint`);
  }
};

const EMAIL_PARTS = { subject: (n: FormOps['notifications'][number]) => n.subject, body: (n: FormOps['notifications'][number]) => n.body } as const;

/**
 * The FormOps half of `lockFingerprint`: an email lock projects the bound notification's subject, body and
 * footer (its `brandBlock` footer nodes), a PDF lock the bound PDF template's header and footer. The bound item
 * is the binding's `instanceRootId` (`idMap['$root']`).
 */
export function opsLockFingerprint(ops: Pick<FormOps, 'notifications' | 'pdfTemplates'>, binding: FormTemplateBinding, lock: LockSpec): Sha256Hex {
  const back = inverseRemapOf(binding.idMap, binding.keyMap);
  const id = binding.instanceRootId ?? binding.idMap[ROOT_SOURCE_ID];
  const target = lock.target;
  if (target.kind === 'email') {
    const n = ops.notifications.find((x) => x.id === id);
    if (!n) return hash(lock, { present: false });
    const parts = Object.fromEntries([...target.parts].sort().map((part) => [
      part,
      part === 'footer' ? n.body.content.filter((node) => node.type === 'brandBlock' && node.attrs.part !== 'header') : EMAIL_PARTS[part](n),
    ]));
    return hash(lock, remapRefs({ present: true, parts }, back));
  }
  if (target.kind === 'pdf') {
    const pdf = ops.pdfTemplates.find((x) => x.id === id);
    if (!pdf) return hash(lock, { present: false });
    const parts = Object.fromEntries([...target.parts].sort().map((part) => [part, pdf[part] ?? null]));
    return hash(lock, remapRefs({ present: true, parts }, back));
  }
  throw new TemplateCoreError('lock_target_in_definition', `${target.kind} locks are fingerprinted from the definition: use lockFingerprint`);
}
