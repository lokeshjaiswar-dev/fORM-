/* JSON and XML response parsing. Pure: used by the server proxy and by the builder's tree picker. */

export type ApiLeafType = 'string' | 'number' | 'boolean';

export interface ApiResponseLeaf {
  key: string;
  type: ApiLeafType;
  value: string | number | boolean;
}

export interface ApiCollection {
  key: string;
  kind: 'array' | 'map';
  length: number;
  primitive: boolean;
  itemKeys: string[];
}

export interface ApiParseResult {
  data: unknown;
  leaves: ApiResponseLeaf[];
  collections: ApiCollection[];
}

export function parseApiBody(text: string, parser: 'json' | 'xml'): ApiParseResult {
  if (parser === 'xml') return parseXml(text);
  try {
    return flattenUnknown(JSON.parse(text) as unknown);
  } catch {
    return { data: undefined, leaves: [], collections: [] };
  }
}

export function getAtPath(data: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = data;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const RECORD_KEYS = new Set(['id', 'name', 'label', 'code', 'value', 'title', 'key', 'ok', 'success', 'status', 'message', 'count']);

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

function objectItemKeys(item: unknown): string[] {
  if (item == null || typeof item !== 'object' || Array.isArray(item)) return [];
  return Object.keys(item).slice(0, 32);
}

function asMapCollection(value: Record<string, unknown>, path: string): ApiCollection | undefined {
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const values = entries.map(([, v]) => v);
  if (entries.length >= 2 && values.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
    return { key: path, kind: 'map', length: entries.length, primitive: false, itemKeys: objectItemKeys(values[0]) };
  }
  if (values.every(isPrimitive)) {
    const keys = entries.map(([k]) => k);
    if (keys.length < 2) return undefined;
    if (keys.some((k) => RECORD_KEYS.has(k.toLowerCase()))) return undefined;
    return { key: path, kind: 'map', length: entries.length, primitive: true, itemKeys: [] };
  }
  return undefined;
}

function flattenUnknown(data: unknown): ApiParseResult {
  const leaves: ApiResponseLeaf[] = [];
  const collections: ApiCollection[] = [];
  walk(data, '', leaves, collections);
  return { data, leaves, collections };
}

function walk(value: unknown, path: string, leaves: ApiResponseLeaf[], collections: ApiCollection[]): void {
  if (value === null || value === undefined) return;
  if (isPrimitive(value)) {
    if (!path) return;
    const type: ApiLeafType = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string';
    leaves.push({ key: path, type, value });
    return;
  }
  if (Array.isArray(value)) {
    collections.push({
      key: path,
      kind: 'array',
      length: value.length,
      primitive: value.every(isPrimitive),
      itemKeys: objectItemKeys(value.find((item) => item && typeof item === 'object' && !Array.isArray(item))),
    });
    value.forEach((item, i) => walk(item, path ? `${path}[${i}]` : `[${i}]`, leaves, collections));
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const mapped = asMapCollection(record, path);
    if (mapped) collections.push(mapped);
    for (const [key, child] of Object.entries(record)) {
      walk(child, path ? `${path}.${key}` : key, leaves, collections);
    }
  }
}

function coerceXmlText(text: string): string | number | boolean {
  const raw = text.trim();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

function readXmlElement(source: string, start: number): { name: string; value: unknown; next: number } | null {
  if (source[start] !== '<') return null;
  const tagEnd = source.indexOf('>', start);
  if (tagEnd < 0) return null;
  const raw = source.slice(start + 1, tagEnd).trim();
  if (!raw || raw.startsWith('/') || raw.startsWith('!') || raw.startsWith('?')) return null;
  const selfClosing = raw.endsWith('/');
  const open = (selfClosing ? raw.slice(0, -1) : raw).trim();
  const name = open.split(/\s+/, 1)[0];
  if (!name) return null;
  if (selfClosing) return { name, value: '', next: tagEnd + 1 };
  let pos = tagEnd + 1;
  const children: Record<string, unknown> = {};
  let text = '';
  let hasChild = false;
  const close = `</${name}>`;
  while (pos < source.length) {
    if (source.startsWith(close, pos)) {
      return { name, value: hasChild ? children : coerceXmlText(text), next: pos + close.length };
    }
    if (source[pos] === '<' && source[pos + 1] !== '/') {
      const child = readXmlElement(source, pos);
      if (!child) return null;
      hasChild = true;
      if (child.name in children) {
        const prev = children[child.name];
        children[child.name] = Array.isArray(prev) ? [...prev, child.value] : [prev, child.value];
      } else children[child.name] = child.value;
      pos = child.next;
      continue;
    }
    text += source[pos];
    pos += 1;
  }
  return null;
}

function parseXml(text: string): ApiParseResult {
  const cleaned = text.replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const parsed = readXmlElement(cleaned, 0);
  if (!parsed) return { data: undefined, leaves: [], collections: [] };
  const data = parsed.value;
  return flattenUnknown(typeof data === 'object' && data !== null && !Array.isArray(data) ? data : { [parsed.name]: data });
}

