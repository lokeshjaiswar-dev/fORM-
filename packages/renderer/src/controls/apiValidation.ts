import type { AnswerValue, Answers, ApiRequestConfig, ApiSuccessRule, ApiValidation, FieldBlock, FieldError, PublicFormDefinition, SafeUrl } from '@form/schema';

export interface ApiCheckResult {
  ok: boolean;
  message?: string;
}

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

const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/;

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

export function matchSuccessRule(value: unknown, rule: ApiSuccessRule): boolean {
  if (rule.type === 'boolean') {
    if (typeof value === 'boolean') return value === rule.equals;
    if (value === 'true' || value === 'false') return (value === 'true') === rule.equals;
    return false;
  }
  if (rule.type === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
    return Number.isFinite(n) && n === rule.equals;
  }
  const shown = value == null ? '' : String(value).trim();
  return rule.equals.some((allowed) => allowed.trim() === shown);
}

export function defaultSuccess(leaf: ApiResponseLeaf): ApiSuccessRule {
  if (leaf.type === 'boolean') return { type: 'boolean', equals: leaf.value === true };
  if (leaf.type === 'number') return { type: 'number', equals: typeof leaf.value === 'number' ? leaf.value : 1 };
  const text = String(leaf.value).trim() || 'ok';
  return { type: 'string', equals: [text] };
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

function authHeaders(auth: ApiValidation['auth']): Record<string, string> {
  if (!auth) return {};
  if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token}` };
  if (auth.type === 'api_key') return HEADER_NAME.test(auth.header) ? { [auth.header]: auth.value } : {};
  const token = btoa(`${auth.username}:${auth.password}`);
  return { Authorization: `Basic ${token}` };
}

export function buildApiRequest(config: ApiRequestConfig, fieldKey?: string, value?: unknown): { url: string; init: RequestInit } {
  const method = config.method ?? 'POST';
  const parser = config.parser ?? 'json';
  const accept = parser === 'xml' ? 'application/xml, text/xml, application/json' : 'application/json';
  const url = new URL(config.url);
  for (const pair of config.query ?? []) {
    if (pair.key) url.searchParams.set(pair.key, pair.value);
  }
  const headers: Record<string, string> = { Accept: accept, ...authHeaders(config.auth) };
  if (method === 'GET') {
    if (fieldKey) url.searchParams.set(fieldKey, value == null ? '' : String(value));
    return { url: url.toString(), init: { method: 'GET', headers } };
  }
  const body: Record<string, unknown> = {};
  for (const pair of config.body ?? []) {
    if (pair.key) body[pair.key] = pair.value;
  }
  if (fieldKey) body[fieldKey] = value;
  headers['Content-Type'] = 'application/json';
  return { url: url.toString(), init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

export async function callFieldApi(config: ApiValidation, fieldKey: string, value: unknown): Promise<ApiCheckResult> {
  try {
    const { url, init } = buildApiRequest(config, fieldKey, value);
    const res = await fetch(url, init);
    const text = await res.text();
    const parser = config.parser ?? 'json';
    const parsed = text ? parseApiBody(text, parser) : { data: undefined, leaves: [], collections: [] };
    if (config.responseKey && config.success) {
      const leaf = getAtPath(parsed.data, config.responseKey);
      return { ok: matchSuccessRule(leaf, config.success) };
    }
    if (parsed.data && typeof parsed.data === 'object' && 'ok' in parsed.data) {
      const body = parsed.data as { ok: unknown; message?: unknown };
      const message = typeof body.message === 'string' && body.message.trim() ? body.message : '';
      return message ? { ok: body.ok === true, message } : { ok: body.ok === true };
    }
    return { ok: res.ok };
  } catch {
    return { ok: false, message: 'Could not reach the validation API.' };
  }
}

/** @deprecated use callFieldApi */
export async function postFieldApi(url: SafeUrl, fieldKey: string, value: unknown): Promise<ApiCheckResult> {
  return callFieldApi({ url }, fieldKey, value);
}

export function payloadValue(answer: AnswerValue | undefined): unknown {
  if (!answer) return undefined;
  const value = answer.value as unknown;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

/** Visible fields with `apiValidation` that currently have an answer. */
export function apiValidationTargets(
  def: PublicFormDefinition,
  answers: Answers,
  visible: ReadonlySet<string>,
  pageId?: string,
): FieldBlock[] {
  const onPage = pageId ? new Set(def.pages.find((p) => p.id === pageId)?.children ?? []) : null;
  const out: FieldBlock[] = [];
  for (const block of Object.values(def.blocks)) {
    if (!block || !('key' in block) || !block.apiValidation) continue;
    if (!visible.has(block.id)) continue;
    if (onPage && !onPage.has(block.id)) continue;
    if (payloadValue(answers[block.id]) === undefined) continue;
    out.push(block);
  }
  return out;
}

export async function verifyFieldApis(
  def: PublicFormDefinition,
  answers: Answers,
  visible: ReadonlySet<string>,
  pageId: string | undefined,
  fallback: string,
): Promise<FieldError[]> {
  const checks = apiValidationTargets(def, answers, visible, pageId).map(async (block): Promise<FieldError | null> => {
    const value = payloadValue(answers[block.id]);
    const config = block.apiValidation;
    if (value === undefined || config === undefined) return null;
    const result = await callFieldApi(config, block.key, value);
    if (result.ok) return null;
    return { blockId: block.id, code: 'api_failed', message: result.message ?? fallback };
  });
  return (await Promise.all(checks)).filter((error): error is FieldError => error !== null);
}
