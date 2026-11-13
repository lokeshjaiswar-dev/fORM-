import type { ApiOptions, ChoiceOption, OptionId } from '@form/schema';
import { buildApiRequest, getAtPath, parseApiBody } from './apiValidation.ts';

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const MAX = 5000;

export function collectionLabel(path: string): string {
  return path === '' ? '(root)' : path;
}

export type TreePick = {
  itemsPath: string;
  collectionKind: 'array' | 'map';
  field: string;
};

type PathSeg = { kind: 'key'; key: string } | { kind: 'index'; index: number };

const RECORD_KEYS = new Set(['id', 'name', 'label', 'code', 'value', 'title', 'key', 'ok', 'success', 'status', 'message', 'count']);

export function parseResponsePath(path: string): PathSeg[] {
  const segs: PathSeg[] = [];
  const re = /\[(\d+)\]|[^.[\]]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path))) {
    if (match[1] !== undefined) segs.push({ kind: 'index', index: Number(match[1]) });
    else segs.push({ kind: 'key', key: match[0] });
  }
  return segs;
}

function isMapObject(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 2) return false;
  const values = entries.map(([, child]) => child);
  if (values.every((child) => child !== null && typeof child === 'object' && !Array.isArray(child))) return true;
  if (values.every((child) => typeof child === 'boolean' || typeof child === 'number' || typeof child === 'string')) {
    return !entries.some(([key]) => RECORD_KEYS.has(key.toLowerCase()));
  }
  return false;
}

function addSeg(prefix: string, seg: PathSeg): string {
  if (seg.kind === 'index') return `${prefix}[${seg.index}]`;
  return prefix ? `${prefix}.${seg.key}` : seg.key;
}

/** Turn a clicked tree path into the list + field used to build options. */
export function pickFromTree(data: unknown, path: string, part: 'leaf' | 'entryKey' | 'list' = 'leaf'): TreePick | undefined {
  const segs = parseResponsePath(path);
  let cur: unknown = data;
  let prefix = '';
  let itemsPath: string | undefined;
  let collectionKind: 'array' | 'map' | undefined;
  let rest: PathSeg[] = [];
  let inItem = false;

  if (part === 'list') {
    const at = path === '' ? data : getAtPath(data, path);
    if (Array.isArray(at)) return { itemsPath: path, collectionKind: 'array', field: '$self' };
    if (isMapObject(at)) return { itemsPath: path, collectionKind: 'map', field: '$self' };
  }

  for (const seg of segs) {
    if (inItem) {
      rest.push(seg);
      if (seg.kind === 'index' && Array.isArray(cur)) cur = cur[seg.index];
      else if (seg.kind === 'key' && cur && typeof cur === 'object' && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[seg.key];
      else return undefined;
      continue;
    }
    if (Array.isArray(cur) && seg.kind === 'index') {
      itemsPath = prefix;
      collectionKind = 'array';
      inItem = true;
      cur = cur[seg.index];
      prefix = addSeg(prefix, seg);
      continue;
    }
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && seg.kind === 'key') {
      if (isMapObject(cur)) {
        itemsPath = prefix;
        collectionKind = 'map';
        inItem = true;
      }
      cur = (cur as Record<string, unknown>)[seg.key];
      prefix = addSeg(prefix, seg);
      continue;
    }
    return undefined;
  }

  if (!inItem) {
    if (Array.isArray(cur)) return { itemsPath: prefix, collectionKind: 'array', field: '$self' };
    if (isMapObject(cur)) return { itemsPath: prefix, collectionKind: 'map', field: part === 'entryKey' ? '$key' : '$self' };
    return undefined;
  }
  if (itemsPath === undefined || collectionKind === undefined) return undefined;
  const field = rest.filter((seg): seg is { kind: 'key'; key: string } => seg.kind === 'key').map((seg) => seg.key).join('.');
  if (part === 'entryKey' && collectionKind === 'map' && !field) return { itemsPath, collectionKind, field: '$key' };
  return { itemsPath, collectionKind, field: field || '$self' };
}

/** Path shown on the label/value chips, e.g. response.data.cities[].name */
export function displayOptionPath(itemsPath: string, field: string): string {
  const base = itemsPath ? `response.${itemsPath}` : 'response';
  if (field === '$self') return `${base}[]`;
  if (field === '$key') return `${base}[]`;
  return `${base}[].${field}`;
}

export function guessMapping(kind: 'array' | 'map', primitive: boolean, itemKeys: readonly string[]): { labelKey?: string; valueKey?: string } {
  const pick = (...names: string[]) => itemKeys.find((key) => names.includes(key.toLowerCase()));
  const mapping: { labelKey?: string; valueKey?: string } = {};
  if (kind === 'map') {
    mapping.valueKey = '$key';
    if (primitive) mapping.labelKey = '$self';
    else {
      const label = pick('name', 'label', 'title', 'text') ?? itemKeys[0];
      if (label) mapping.labelKey = label;
    }
    return mapping;
  }
  if (primitive) {
    mapping.labelKey = '$self';
    mapping.valueKey = '$self';
    return mapping;
  }
  const labelKey = pick('name', 'label', 'title', 'text') ?? itemKeys[0];
  const valueKey = pick('id', 'code', 'value', 'key') ?? labelKey;
  if (labelKey) mapping.labelKey = labelKey;
  if (valueKey) mapping.valueKey = valueKey;
  return mapping;
}

function readField(item: unknown, mapKey: string | undefined, path: string | undefined): string {
  if (!path || path === '$self') {
    if (item == null || typeof item === 'object') return '';
    return String(item).trim();
  }
  if (path === '$key') return (mapKey ?? '').trim();
  const value = getAtPath(item, path);
  if (value == null || typeof value === 'object') return '';
  return String(value).trim();
}

function toOptionId(raw: string, index: number, used: Set<string>): OptionId {
  let base = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  if (!base || RESERVED.has(base)) base = `opt_${index + 1}`;
  let id = base;
  let n = 2;
  while (used.has(id)) {
    const suffix = `_${n}`;
    id = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    n += 1;
  }
  used.add(id);
  return id as OptionId;
}

export function mapApiOptions(data: unknown, config: ApiOptions): ChoiceOption[] {
  const path = config.itemsPath ?? '';
  const root = path === '' ? data : getAtPath(data, path);
  const kind = config.collectionKind ?? (Array.isArray(root) ? 'array' : 'map');
  const rows: Array<{ item: unknown; key?: string }> = [];
  if (kind === 'array' && Array.isArray(root)) {
    for (const item of root) rows.push({ item });
  } else if (kind === 'map' && root && typeof root === 'object' && !Array.isArray(root)) {
    for (const [key, item] of Object.entries(root as Record<string, unknown>)) rows.push({ item, key });
  }
  const used = new Set<string>();
  const options: ChoiceOption[] = [];
  for (const [index, row] of rows.entries()) {
    if (options.length >= MAX) break;
    const label = readField(row.item, row.key, config.labelKey) || readField(row.item, row.key, config.valueKey);
    const value = readField(row.item, row.key, config.valueKey) || label;
    if (!label && !value) continue;
    const id = toOptionId(value || label, index, used);
    const option: ChoiceOption = { id, label: label || value };
    if (value && value !== id) option.code = value.slice(0, 200);
    options.push(option);
  }
  return options;
}

export async function fetchApiOptions(config: ApiOptions): Promise<ChoiceOption[]> {
  if (config.itemsPath === undefined) return [];
  try {
    const { url, init } = buildApiRequest(config);
    const res = await fetch(url, init);
    const text = await res.text();
    const parsed = text ? parseApiBody(text, config.parser ?? 'json') : { data: undefined };
    return mapApiOptions(parsed.data, config);
  } catch {
    return [];
  }
}
