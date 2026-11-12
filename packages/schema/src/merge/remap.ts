const ID_KEYS = new Set([
  'id', 'blockId', 'varId', 'endingId', 'groupId', 'repeatingGroupId', 'anchorBlockId', 'atPage', 'target', 'from', 'to',
  'pageId',
]);
const ID_ARRAYS = new Set(['targets', 'optionIds', 'children', 'purposeIds']);

export function remapValue(value: unknown, map: ReadonlyMap<string, string>, prop?: string): unknown {
  if (typeof value === 'string') {
    if (prop && (ID_KEYS.has(prop) || ID_ARRAYS.has(prop))) return map.get(value) ?? value;
    return value;
  }
  if (Array.isArray(value)) {
    if (prop && ID_ARRAYS.has(prop)) return value.map((item) => (typeof item === 'string' ? (map.get(item) ?? item) : remapValue(item, map)));
    return value.map((item) => remapValue(item, map, prop));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = remapValue(child, map, key);
    return out;
  }
  return value;
}

export function uniqueKey(key: string, taken: Set<string>): string {
  if (!taken.has(key)) return key;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${key.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    if (!taken.has(candidate) && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)) return candidate;
  }
}
