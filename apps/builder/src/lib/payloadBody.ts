/** One mapped key. `path` is dotted: `customer.name`, `order.lines[].item`. */
export interface PayloadKey {
  path: string;
  /** Shown in the preview in place of a real answer. An array spreads across a `[]` segment. */
  sample: unknown;
}

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const INDEX = /^\d+$/;
const REPEATED = /^([A-Za-z_][A-Za-z0-9_-]*)\[\]$/;

/** Split a typed path into object keys, array indexes, and `name[]` repeaters. */
export function pathSegments(path: string): string[] | null {
  const trimmed = path.trim();
  if (!trimmed) return [];
  const parts = trimmed.split('.');
  if (parts.some((part) => !SEGMENT.test(part) && !INDEX.test(part) && !REPEATED.test(part))) return null;
  return parts;
}

function assign(root: unknown, parts: string[], sample: unknown): unknown {
  if (!parts.length) return sample;
  const [head, ...rest] = parts;
  const repeated = REPEATED.exec(head!);
  if (repeated) {
    const obj = root && typeof root === 'object' && !Array.isArray(root) ? { ...(root as Record<string, unknown>) } : {};
    const existing = Array.isArray(obj[repeated[1]!]) ? [...(obj[repeated[1]!] as unknown[])] : [];
    const rows = Array.isArray(sample) ? sample : [sample];
    rows.forEach((row, index) => {
      existing[index] = assign(existing[index], rest, row);
    });
    obj[repeated[1]!] = existing;
    return obj;
  }
  const index = INDEX.test(head!) ? Number(head) : null;
  if (index !== null) {
    const list = Array.isArray(root) ? [...root] : [];
    list[index] = assign(list[index], rest, sample);
    return list;
  }
  const obj = root && typeof root === 'object' && !Array.isArray(root) ? { ...(root as Record<string, unknown>) } : {};
  obj[head!] = assign(obj[head!], rest, sample);
  return obj;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlNode(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    return value.map((item, i) => `${indent}<item index="${i}">\n${xmlNode(item, indent + '  ')}\n${indent}</item>`).join('\n');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => {
        const inner = xmlNode(child, indent + '  ');
        if (typeof child !== 'object' || child === null) return `${indent}<${key}>${inner}</${key}>`;
        return `${indent}<${key}>\n${inner}\n${indent}</${key}>`;
      })
      .join('\n');
  }
  return escapeXml(String(value ?? ''));
}

/** The body those paths produce. Samples stand in for answers. Invalid paths are reported, not rendered. */
export function payloadPreview(format: 'json' | 'xml', keys: PayloadKey[]): { text: string; invalid: string[] } {
  const invalid: string[] = [];
  let tree: unknown = {};
  for (const key of keys) {
    const parts = pathSegments(key.path);
    if (parts === null) {
      invalid.push(key.path.trim());
      continue;
    }
    if (!parts.length) continue;
    tree = assign(tree, parts, key.sample);
  }
  if (format === 'json') return { text: JSON.stringify(tree, null, 2), invalid };
  const inner = xmlNode(tree, '  ');
  return { text: `<submission>\n${inner}\n</submission>`, invalid };
}
