/**
 * Id and key remapping over v2 JSON. The reference sites are the ones `validateStructure` checks (I4):
 * element ids (blocks, pages and endings share one namespace), rules, rule groups, logic variables,
 * purposes and condition ids. Option, matrix, consent-item and product ids are scoped to their block and
 * are kept. Opaque payloads (`x-*` extensions, an unsupported block's `raw`) are copied verbatim.
 */

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

export const ID_NAMESPACES = ['element', 'rule', 'rule_group', 'variable', 'purpose', 'condition'] as const;
export type IdNamespace = (typeof ID_NAMESPACES)[number];

/** The `idMap` key (and uuidv5 name) of a source id: element ids as they are, other namespaces prefixed. */
export const mapKey = (ns: IdNamespace, sourceId: string): string => (ns === 'element' ? sourceId : `${ns}:${sourceId}`);

/** Splits an `idMap` key back into its namespace and source id. */
export function parseMapKey(key: string): { ns: IdNamespace; sourceId: string } {
  const i = key.indexOf(':');
  const ns = i < 0 ? undefined : ID_NAMESPACES.find((n) => n === key.slice(0, i));
  return ns ? { ns, sourceId: key.slice(i + 1) } : { ns: 'element', sourceId: key };
}

export interface Remap {
  /** The mapped id, or `id` itself when it is not in the map (a dangling reference stays dangling). */
  id(ns: IdNamespace, id: string): string;
  key(key: string): string;
}

export const IDENTITY: Remap = { id: (_ns, id) => id, key: (key) => key };

/** A remap from an `idMap` (keys from `mapKey`) and an optional `keyMap`. */
export function remapOf(idMap: Readonly<Record<string, string>>, keyMap: Readonly<Record<string, string>> = {}): Remap {
  return {
    id: (ns, id) => (Object.hasOwn(idMap, mapKey(ns, id)) ? idMap[mapKey(ns, id)] ?? id : id),
    key: (key) => (Object.hasOwn(keyMap, key) ? keyMap[key] ?? key : key),
  };
}

/** The reverse of `remapOf`: instance ids and keys back to template source ids and keys. */
export function inverseRemapOf(idMap: Readonly<Record<string, string>>, keyMap: Readonly<Record<string, string>> = {}): Remap {
  const ids = new Map<string, string>();
  for (const [key, instance] of Object.entries(idMap)) {
    const { ns, sourceId } = parseMapKey(key);
    ids.set(`${ns} ${instance}`, sourceId);
  }
  const keys = new Map<string, string>();
  for (const [source, instance] of Object.entries(keyMap)) keys.set(instance, source);
  return { id: (ns, id) => ids.get(`${ns} ${id}`) ?? id, key: (key) => keys.get(key) ?? key };
}

/** Deep copy of JSON data. */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => cloneJson(v)) as T;
  if (!isRec(value)) return value;
  const out: Rec = {};
  for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v);
  return out as T;
}

const ELEMENT_KEYS = /^(blockId|target|targets|children|atPage|pageId|endingId|defaultEndingId|repeatingGroupId|[a-z][A-Za-z]*BlockId)$/;
const PURPOSE_KEYS: ReadonlySet<string> = new Set(['purposeId', 'purposeIds', 'requiresPurposeId']);
const KEY_LISTS: ReadonlySet<string> = new Set(['carryKeys', 'keys']);

/** Opaque payloads the schema does not describe. */
export const isOpaque = (parent: Rec, key: string): boolean => key.startsWith('x-') || (key === 'raw' && parent['type'] === 'unsupported');

/** Every id reference in `value` (any v2 fragment) mapped through `remap`; a new value, the input is not touched. */
export function remapRefs<T>(value: T, remap: Remap): T {
  const ids = (v: unknown, ns: IdNamespace): unknown => {
    if (typeof v === 'string') return remap.id(ns, v);
    if (Array.isArray(v)) return v.map((item: unknown) => (typeof item === 'string' ? remap.id(ns, item) : walk(item)));
    return walk(v);
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isRec(v)) return v;
    const condition = (v['kind'] === 'condition' || v['kind'] === 'group') && typeof v['id'] === 'string';
    const jump = v['type'] === 'skip_to_page' || v['type'] === 'skip_to_end';
    const out: Rec = {};
    for (const [k, child] of Object.entries(v)) {
      if (isOpaque(v, k)) out[k] = cloneJson(child);
      else if (condition && k === 'id') out[k] = ids(child, 'condition');
      else if (jump && (k === 'from' || k === 'to')) out[k] = ids(child, 'element');
      else if (ELEMENT_KEYS.test(k)) out[k] = ids(child, 'element');
      else if (k === 'varId') out[k] = ids(child, 'variable');
      else if (PURPOSE_KEYS.has(k)) out[k] = ids(child, 'purpose');
      else if (k === 'groupId') out[k] = ids(child, 'rule_group');
      else if (KEY_LISTS.has(k) && Array.isArray(child)) out[k] = child.map((item: unknown) => (typeof item === 'string' ? remap.key(item) : walk(item)));
      else out[k] = walk(child);
    }
    if (v['type'] === 'answersTable' && isRec(out['attrs']) && Array.isArray(out['attrs']['include'])) {
      out['attrs'] = { ...out['attrs'], include: ids(out['attrs']['include'], 'element') };
    }
    return out;
  };
  return walk(value) as T;
}

const ELEMENT_KEY_PREFIXES: ReadonlySet<string> = new Set(['page', 'block', 'consent', 'ending']);
const SCOPED_KEY_PREFIXES: ReadonlySet<string> = new Set(['option', 'mrow', 'mcol', 'product']);

/** The id a TextKey (`block:<id>:label`, `option:<blockId>/<optionId>`, `rule:<id>:<i>` …) is about, if any. */
export function textKeyRef(key: string): { ns: IdNamespace; id: string; start: number; end: number } | null {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const prefix = key.slice(0, i);
  const start = i + 1;
  const stop = (sep: string) => {
    const j = key.indexOf(sep, start);
    return j < 0 ? key.length : j;
  };
  if (ELEMENT_KEY_PREFIXES.has(prefix)) return { ns: 'element', id: key.slice(start, stop(':')), start, end: stop(':') };
  if (SCOPED_KEY_PREFIXES.has(prefix)) return { ns: 'element', id: key.slice(start, stop('/')), start, end: stop('/') };
  if (prefix === 'purpose') return { ns: 'purpose', id: key.slice(start, stop(':')), start, end: stop(':') };
  if (prefix === 'rule') return { ns: 'rule', id: key.slice(start, stop(':')), start, end: stop(':') };
  return null;
}

/** A TextKey with the id it is about mapped through `remap`. */
export function remapTextKey<K extends string>(key: K, remap: Remap): K {
  const ref = textKeyRef(key);
  return (ref ? `${key.slice(0, ref.start)}${remap.id(ref.ns, ref.id)}${key.slice(ref.end)}` : key) as K;
}
