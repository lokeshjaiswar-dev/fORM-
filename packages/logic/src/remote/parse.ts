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

/**
 * Bounds on a parsed answer. The parser runs on the shared API (the lookup proxy and the author route), so a hostile upstream
 * must cost linear time and never throw: past either bound the answer is unparsable (the proxy's fixed 502).
 */
export const PARSE_LIMITS = { depth: 64, elements: 50_000 } as const;

/**
 * The parsed answer only, without the leaves and collections walk (the server needs no tree picker). `undefined` when the
 * text is not JSON or XML, nests deeper than `PARSE_LIMITS.depth`, or (XML) holds more than `PARSE_LIMITS.elements` elements.
 * Never throws.
 */
export function parseApiData(text: string, parser: 'json' | 'xml'): unknown {
  try {
    if (parser === 'xml') return parseXmlData(text);
    const data = JSON.parse(text) as unknown;
    return withinDepth(data, PARSE_LIMITS.depth) ? data : undefined;
  } catch {
    return undefined;
  }
}

export function parseApiBody(text: string, parser: 'json' | 'xml'): ApiParseResult {
  const data = parseApiData(text, parser);
  if (data === undefined) return { data: undefined, leaves: [], collections: [] };
  try {
    return flattenUnknown(data);
  } catch {
    return { data: undefined, leaves: [], collections: [] };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Iterative, so a deep tree is a `false`, never a stack overflow. */
function withinDepth(value: unknown, max: number): boolean {
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (d >= max) return false;
    for (const child of Array.isArray(v) ? v : Object.values(v)) if (child !== null && typeof child === 'object') stack.push({ v: child, d: d + 1 });
  }
  return true;
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
  walk(data, '', leaves, collections, 0);
  return { data, leaves, collections };
}

function walk(value: unknown, path: string, leaves: ApiResponseLeaf[], collections: ApiCollection[], depth: number): void {
  if (value === null || value === undefined || depth > PARSE_LIMITS.depth) return;
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
    value.forEach((item, i) => walk(item, path ? `${path}[${i}]` : `[${i}]`, leaves, collections, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const mapped = asMapCollection(record, path);
    if (mapped) collections.push(mapped);
    for (const [key, child] of Object.entries(record)) {
      walk(child, path ? `${path}.${key}` : key, leaves, collections, depth + 1);
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

/**
 * The declaration, processing instructions and comments taken out in one pass (`indexOf`, so linear: a lazy regex rescans the
 * rest of the body once per unclosed `<!--`). One left unclosed makes the text unparsable (null).
 */
function stripXmlNoise(text: string): string | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      parts.push(text.slice(i));
      return parts.join('');
    }
    const [open, close] = text.startsWith('<!--', lt) ? ['<!--', '-->'] : text.startsWith('<?', lt) ? ['<?', '?>'] : [null, null];
    if (open === null) {
      parts.push(text.slice(i, lt + 1));
      i = lt + 1;
      continue;
    }
    const end = text.indexOf(close, lt + open.length);
    if (end < 0) return null;
    parts.push(text.slice(i, lt));
    i = end + close.length;
  }
}

/** An open element of the XML reader: its children by name (a repeated name collects into one array, in place) and its text. */
interface XmlFrame {
  name: string;
  close: string;
  children: Map<string, unknown>;
  repeated: Set<string>;
  text: string[];
}

/** `<name ...>` at `at`: the name, whether it closes itself, and where the tag ends. null for anything that is not an element. */
function readXmlTag(source: string, at: number): { name: string; selfClosing: boolean; next: number } | null {
  const tagEnd = source.indexOf('>', at);
  if (tagEnd < 0) return null;
  const raw = source.slice(at + 1, tagEnd).trim();
  if (!raw || raw.startsWith('/') || raw.startsWith('!') || raw.startsWith('?')) return null;
  const selfClosing = raw.endsWith('/');
  const name = (selfClosing ? raw.slice(0, -1) : raw).trim().split(/\s+/, 1)[0];
  if (!name) return null;
  return { name, selfClosing, next: tagEnd + 1 };
}

function addXmlChild(frame: XmlFrame, name: string, value: unknown): void {
  if (!frame.children.has(name)) {
    frame.children.set(name, value);
    return;
  }
  if (frame.repeated.has(name)) {
    (frame.children.get(name) as unknown[]).push(value);
    return;
  }
  frame.repeated.add(name);
  frame.children.set(name, [frame.children.get(name), value]);
}

function closeXmlFrame(frame: XmlFrame): unknown {
  // fromEntries defines own properties, so an element named `__proto__` or `constructor` is a plain key.
  return frame.children.size > 0 ? Object.fromEntries(frame.children) : coerceXmlText(frame.text.join(''));
}

/**
 * The root element of a small XML subset as a plain tree: attributes are ignored, an element with children is an object, a
 * repeated child name is an array, text is coerced. Iterative and linear; deeper than `PARSE_LIMITS.depth`, more than
 * `PARSE_LIMITS.elements` elements, or malformed gives null.
 */
function readXmlRoot(source: string): { name: string; value: unknown } | null {
  if (source[0] !== '<') return null;
  const root = readXmlTag(source, 0);
  if (!root) return null;
  if (root.selfClosing) return { name: root.name, value: '' };
  const frame = (name: string): XmlFrame => ({ name, close: `</${name}>`, children: new Map(), repeated: new Set(), text: [] });
  const stack: XmlFrame[] = [frame(root.name)];
  let elements = 1;
  let pos = root.next;
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const lt = source.indexOf('<', pos);
    if (lt < 0) return null;
    if (top.children.size === 0) top.text.push(source.slice(pos, lt));
    if (source.startsWith(top.close, lt)) {
      stack.pop();
      pos = lt + top.close.length;
      const value = closeXmlFrame(top);
      const parent = stack[stack.length - 1];
      if (!parent) return { name: top.name, value };
      addXmlChild(parent, top.name, value);
      continue;
    }
    if (source[lt + 1] === '/') {
      // A closing tag of another element: text, as before.
      if (top.children.size === 0) top.text.push('<');
      pos = lt + 1;
      continue;
    }
    const tag = readXmlTag(source, lt);
    if (!tag) return null;
    elements += 1;
    if (elements > PARSE_LIMITS.elements) return null;
    top.text.length = 0;
    pos = tag.next;
    if (tag.selfClosing) {
      addXmlChild(top, tag.name, '');
      continue;
    }
    if (stack.length >= PARSE_LIMITS.depth) return null;
    stack.push(frame(tag.name));
  }
  return null;
}

/** A root with children is the tree itself; a root with only text is `{ [root]: value }`. */
function parseXmlData(text: string): unknown {
  const cleaned = stripXmlNoise(text);
  if (cleaned === null) return undefined;
  const parsed = readXmlRoot(cleaned.trim());
  if (parsed === null) return undefined;
  return isRecord(parsed.value) ? parsed.value : { [parsed.name]: parsed.value };
}
