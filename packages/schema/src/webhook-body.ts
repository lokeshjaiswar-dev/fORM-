import type { WebhookPayloadMapping, WebhookPayloadMeta } from './v2/ops.ts';

/*
 * The custom body of a webhook (INT-01): a mapping of dotted paths to sources, rendered as JSON or XML. Pure and shared, so the
 * worker that sends the body and the builder that previews it cannot disagree.
 *
 * This module never reads an answer by itself: the caller hands it `answers` that were ALREADY filtered by the disclosure
 * rules (purposes, redaction, taint), and a source that names a field that is not in that map is skipped. A mapping can
 * therefore only rearrange what the standard payload would have carried; it can never add a field or unmask one.
 */

export const MAX_MAPPING_ENTRIES = 200;
export const MAX_PATH_DEPTH = 8;
export const MAX_SPREAD_ROWS = 5000;
/**
 * The largest mapping, in UTF-8 bytes of its JSON, that can be saved. Migration 0025 caps the stored jsonb at 64 KiB
 * (`pg_column_size(payload_mapping) <= 65536`), and jsonb is about 24 bytes per entry larger than the JSON text (measured on
 * Postgres 18: 200 entries add 4.6 to 4.8 KB), so 56 KiB of JSON always fits. Without this, a schema-valid mapping (200
 * entries of 200-character paths and keys is about 90 KB) passed the API and failed the column check as a 500.
 */
export const MAX_MAPPING_BYTES = 56 * 1024;

/** The UTF-8 size of a string, counted by code point (no TextEncoder: this package also builds without DOM or Node types). */
function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** The UTF-8 size of a mapping's JSON (what MAX_MAPPING_BYTES limits). */
export const mappingBytes = (mapping: WebhookPayloadMapping): number => utf8Length(JSON.stringify(mapping));
const MAX_XML_DEPTH = 24;

const SEGMENT = /^([A-Za-z_][A-Za-z0-9_-]{0,63})(\[\])?$/;
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export interface PathPart {
  name: string;
  /** The segment ended in `[]`: an array answer spreads over it. */
  repeat: boolean;
}

/** An element name is valid in XML 1.0 without namespaces and is not in the reserved `xml` family. */
export const isXmlName = (name: string): boolean => XML_NAME.test(name) && !/^xml/i.test(name);

/** `customer.name` -> parts; null when any segment is not a plain name (optionally `[]`), is reserved or the path is too deep. */
export function parsePath(path: string): PathPart[] | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed.length > 200) return null;
  const segments = trimmed.split('.');
  if (segments.length > MAX_PATH_DEPTH) return null;
  const parts: PathPart[] = [];
  for (const segment of segments) {
    const m = SEGMENT.exec(segment);
    if (!m || FORBIDDEN.has(m[1]!) || !isXmlName(m[1]!)) return null;
    parts.push({ name: m[1]!, repeat: m[2] === '[]' });
  }
  return parts;
}

/** Why a mapping cannot be saved, one line each; empty when it is fine. The same check runs in the API, the builder and the worker. */
export function validateMapping(mapping: WebhookPayloadMapping): string[] {
  const issues: string[] = [];
  if (mapping.root !== undefined && !isXmlName(mapping.root)) issues.push(`"${mapping.root}" is not a valid XML root element name`);
  if (mapping.entries.length > MAX_MAPPING_ENTRIES) issues.push(`at most ${MAX_MAPPING_ENTRIES} mapped values`);
  const bytes = mappingBytes(mapping);
  if (bytes > MAX_MAPPING_BYTES) issues.push(`the mapping is too large (${Math.ceil(bytes / 1024)} KB; at most ${MAX_MAPPING_BYTES / 1024} KB): use shorter paths or fewer values`);
  // A trie of the paths: a name is a leaf or has children, never both, and `a` and `a[]` are different shapes.
  interface Node { repeat: boolean; leaf: boolean; kids: Map<string, Node> }
  const top = new Map<string, Node>();
  const seen = new Set<string>();
  for (const entry of mapping.entries) {
    const parts = parsePath(entry.path);
    if (!parts) {
      issues.push(`"${entry.path.trim()}" is not a valid path (names, dots and [] only; max ${MAX_PATH_DEPTH} levels)`);
      continue;
    }
    const canonical = parts.map((p) => p.name + (p.repeat ? '[]' : '')).join('.');
    if (seen.has(canonical)) {
      issues.push(`"${canonical}" is mapped twice`);
      continue;
    }
    seen.add(canonical);
    let level = top;
    parts.forEach((part, i) => {
      let node = level.get(part.name);
      if (!node) {
        node = { repeat: part.repeat, leaf: false, kids: new Map() };
        level.set(part.name, node);
      }
      const last = i === parts.length - 1;
      if (node.repeat !== part.repeat) issues.push(`"${canonical}": "${part.name}" is used both with and without []`);
      if (last) {
        if (node.kids.size > 0) issues.push(`"${canonical}" is also the parent of another path`);
        node.leaf = true;
      } else {
        if (node.leaf) issues.push(`"${canonical}": "${part.name}" already holds a value`);
        level = node.kids;
      }
    });
  }
  return [...new Set(issues)];
}

type Tree = Record<string, unknown>;
const isTree = (v: unknown): v is Tree => typeof v === 'object' && v !== null && !Array.isArray(v);
const fresh = (): Tree => Object.create(null) as Tree;

function assign(root: unknown, parts: readonly PathPart[], value: unknown): unknown {
  if (parts.length === 0) return value;
  const [head, ...rest] = parts as [PathPart, ...PathPart[]];
  const obj = isTree(root) ? root : fresh();
  if (head.repeat) {
    const existing = Array.isArray(obj[head.name]) ? (obj[head.name] as unknown[]) : [];
    const rows = (Array.isArray(value) ? value : [value]).slice(0, MAX_SPREAD_ROWS);
    rows.forEach((row, i) => {
      existing[i] = assign(existing[i], rest, row);
    });
    obj[head.name] = existing;
  } else {
    obj[head.name] = assign(obj[head.name], rest, value);
  }
  return obj;
}

export interface MappingSource {
  /** Already disclosure-filtered values by FIELD KEY: an absent key is a field the receiver may not have. */
  answers: Readonly<Record<string, unknown>>;
  meta: Readonly<Record<WebhookPayloadMeta, string>>;
}

export interface AppliedMapping {
  tree: unknown;
  /** The field keys whose value went into the tree. */
  usedKeys: string[];
}

/** Builds the tree of a valid mapping. Throws on an invalid one (the callers validate on save; the worker settles the delivery). */
export function applyMapping(mapping: WebhookPayloadMapping, source: MappingSource): AppliedMapping {
  const issues = validateMapping(mapping);
  if (issues.length > 0) throw new Error(`invalid payload mapping: ${issues[0]}`);
  let tree: unknown = fresh();
  const used = new Set<string>();
  for (const entry of mapping.entries) {
    const parts = parsePath(entry.path)!;
    let value: unknown;
    if (entry.source.kind === 'meta') {
      value = source.meta[entry.source.name];
    } else {
      if (!Object.prototype.hasOwnProperty.call(source.answers, entry.source.key)) continue;
      value = source.answers[entry.source.key];
      used.add(entry.source.key);
    }
    tree = assign(tree, parts, value);
  }
  return { tree, usedKeys: [...used] };
}

// ---------------------------------------------------------------------------------------------------------------- XML

// Characters XML 1.0 cannot carry at all (controls but tab, LF, CR; the non-characters; a lone surrogate) are dropped.
// oxlint-disable-next-line no-control-regex -- the point is to match control characters
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text for element content or an attribute value: illegal characters dropped, the five predefined entities and CR/LF/TAB as character references. */
export function escapeXml(value: string): string {
  return value
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

function element(name: string, value: unknown, depth: number, pretty: boolean, pad: string): string {
  const attr = isXmlName(name) ? '' : ` key="${escapeXml(name)}"`;
  const tag = isXmlName(name) ? name : 'item';
  if (depth > MAX_XML_DEPTH) return `${pad}<${tag}${attr}/>`;
  const nl = pretty ? '\n' : '';
  const inner = pretty ? pad + '  ' : '';
  if (Array.isArray(value)) {
    // An array is its element repeated; an array inside an array is wrapped (`{ item: [...] }`) so its shape survives.
    return value.map((v) => element(tag, Array.isArray(v) ? { item: v } : v, depth + 1, pretty, pad)).join(nl) || `${pad}<${tag}${attr}/>`;
  }
  if (value !== null && typeof value === 'object') {
    const kids = Object.entries(value as Record<string, unknown>).map(([k, v]) => element(k, v, depth + 1, pretty, inner));
    if (kids.length === 0) return `${pad}<${tag}${attr}/>`;
    return `${pad}<${tag}${attr}>${nl}${kids.join(nl)}${nl}${pad}</${tag}>`;
  }
  if (value === null || value === undefined) return `${pad}<${tag}${attr}/>`;
  return `${pad}<${tag}${attr}>${escapeXml(scalarText(value))}</${tag}>`;
}

/** A well-formed XML 1.0 document: declaration, one root, no DTD, no entities beyond the five predefined, names validated. */
export function renderXml(rootName: string, tree: unknown, o: { pretty?: boolean } = {}): string {
  if (!isXmlName(rootName)) throw new Error('invalid XML root element name');
  const pretty = o.pretty === true;
  const body = element(rootName, isTree(tree) ? tree : { value: tree }, 0, pretty, '');
  return `<?xml version="1.0" encoding="UTF-8"?>${pretty ? '\n' : ''}${body}`;
}

export function renderJson(tree: unknown, o: { pretty?: boolean } = {}): string {
  return JSON.stringify(tree, null, o.pretty === true ? 2 : undefined);
}

export const CONTENT_TYPES = { json: 'application/json', xml: 'application/xml; charset=utf-8' } as const;
