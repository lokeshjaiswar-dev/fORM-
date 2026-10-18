import fc from 'fast-check';
import type { z } from 'zod';
import * as S from '../src/index.ts';

/* Derives fast-check arbitraries from the zod twins, so property tests cover every schema without hand-written generators. */

type Arb = fc.Arbitrary<unknown>;
interface Def { type: string; [key: string]: unknown }
interface CheckDef { check: string; [key: string]: unknown }

const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;
const checksOf = (schema: unknown): CheckDef[] =>
  ((defOf(schema)['checks'] as Array<{ _zod: { def: CheckDef } }> | undefined) ?? []).map((c) => c._zod.def);

const word = fc.stringMatching(/^[a-z0-9_]{1,8}$/);
const opaqueId = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/);
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const isoDate = fc.tuple(fc.integer({ min: 1970, max: 2099 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
  .map(([y, m, d]) => `${y}-${pad(m, 2)}-${pad(d, 2)}`);
const isoTime = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(([h, m]) => `${pad(h, 2)}:${pad(m, 2)}`);
const hex = (len: number) => fc.stringMatching(new RegExp(`^[0-9a-f]{${len}}$`));
const decimal = fc.tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.option(fc.stringMatching(/^\d{0,9}[1-9]$/), { nil: undefined }))
  .map(([neg, int, frac]) => `${neg && (int !== 0n || frac) ? '-' : ''}${int}${frac ? `.${frac}` : ''}`);

const BRANDS = new Map<unknown, Arb>([
  [S.FieldKeySchema, fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/)],
  [S.LocaleSchema, fc.constantFrom('en-IN', 'hi-IN', 'ta-IN', 'ur-IN', 'en-XA')],
  [S.TimeZoneSchema, fc.constantFrom('Asia/Kolkata', 'UTC', 'America/New_York')],
  [S.CountryCodeSchema, fc.constantFrom('IN', 'US', 'GB')],
  [S.CurrencyCodeSchema, fc.constantFrom('INR', 'USD')],
  [S.DecimalStringSchema, decimal],
  [S.MinorUnitsSchema, fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }).map(String)],
  [S.IsoDateSchema, isoDate],
  [S.IsoTimeSchema, isoTime],
  [S.IsoLocalDateTimeSchema, fc.tuple(isoDate, isoTime).map(([d, t]) => `${d}T${t}`)],
  [S.IsoInstantSchema, fc.tuple(isoDate, isoTime, fc.integer({ min: 0, max: 59 })).map(([d, t, s]) => `${d}T${t}:${pad(s, 2)}Z`)],
  [S.Sha256HexSchema, hex(64)],
  [S.HexColorSchema, fc.oneof(hex(6), hex(8)).map((h) => `#${h}`)],
  [S.EmailAddressSchema, fc.tuple(word, word).map(([a, b]) => `${a}@${b}.example`)],
  [S.SafeUrlSchema, fc.tuple(fc.constantFrom('https', 'http'), word, word).map(([s, h, p]) => `${s}://${h}.example/${p}`)],
  [S.SafeHrefSchema, fc.oneof(word.map((p) => `https://example.org/${p}`), word.map((a) => `mailto:${a}@example.org`), fc.constant('tel:+911234567890'))],
]);
for (const [name, schema] of Object.entries(S)) {
  if (/IdSchema$/.test(name) && name !== 'FieldKeySchema') BRANDS.set(schema, opaqueId);
}

const MAX_LAZY_DEPTH = 2;

/** Returns null for branches that cannot be generated (transform-only readers). */
export function arbitraryOf(schema: unknown, depth = 0): Arb | null {
  const brand = BRANDS.get(schema);
  if (brand) return brand;
  const def = defOf(schema);
  const child = (s: unknown) => arbitraryOf(s, depth);
  const need = (s: unknown): Arb => {
    const arb = child(s);
    if (!arb) throw new Error(`no arbitrary for ${defOf(s).type}`);
    return arb;
  };
  switch (def.type) {
    case 'string': {
      const checks = checksOf(schema);
      const min = Number(checks.find((c) => c.check === 'min_length')?.['minimum'] ?? 0);
      const max = Number(checks.find((c) => c.check === 'max_length')?.['maximum'] ?? 24);
      const regex = checks.find((c) => c.check === 'string_format' && c['format'] === 'regex')?.['pattern'] as RegExp | undefined;
      if (regex) return fc.stringMatching(new RegExp(regex.source, regex.flags.replace('i', ''))).filter((s) => s.length >= min && s.length <= max);
      return fc.string({ minLength: min, maxLength: Math.max(min, Math.min(max, 24)) });
    }
    case 'number': {
      const checks = checksOf(schema);
      const lower = checks.find((c) => c.check === 'greater_than');
      const upper = checks.find((c) => c.check === 'less_than');
      const isInt = checks.some((c) => c.check === 'number_format' && c['format'] === 'safeint');
      const min = lower ? Number(lower['value']) : -1e6;
      const max = upper ? Number(upper['value']) : 1e6;
      return isInt ? fc.integer({ min: Math.ceil(min), max: Math.floor(max) }) : fc.double({ min, max, noNaN: true, noDefaultInfinity: true }).map((v) => v + 0);
    }
    case 'boolean':
      return fc.boolean();
    case 'literal':
      return fc.constantFrom(...(def['values'] as unknown[]));
    case 'enum':
      return fc.constantFrom(...Object.values(def['entries'] as Record<string, unknown>));
    case 'unknown':
      return fc.jsonValue({ maxDepth: 2 }).map((v) => JSON.parse(JSON.stringify(v)) as unknown);
    case 'nullable':
      return fc.option(need(def['innerType']), { nil: null });
    case 'readonly':
      return child(def['innerType']);
    case 'lazy':
      return arbitraryOf((def['getter'] as () => unknown)(), depth + 1);
    case 'pipe': {
      const out = defOf(def['out']);
      if (out.type === 'transform') return null;
      return defOf(def['in']).type === 'unknown' ? child(def['out']) : child(def['in']);
    }
    case 'array': {
      const checks = checksOf(schema);
      const min = Number(checks.find((c) => c.check === 'min_length')?.['minimum'] ?? 0);
      const max = depth >= MAX_LAZY_DEPTH ? min : Math.max(min, Math.min(Number(checks.find((c) => c.check === 'max_length')?.['maximum'] ?? 2), 2));
      if (max === 0) return fc.constant([]);
      return fc.array(need(def['element']), { minLength: min, maxLength: max });
    }
    case 'tuple':
      return fc.tuple(...(def['items'] as unknown[]).map(need));
    case 'union': {
      const all = def['options'] as unknown[];
      const options = (depth >= MAX_LAZY_DEPTH ? all.slice(0, 1) : all).map(child).filter((a): a is Arb => a !== null);
      const [first, ...rest] = options;
      if (!first) return null;
      return rest.length ? fc.oneof(first, ...rest) : first;
    }
    case 'object': {
      const shape = def['shape'] as Record<string, unknown>;
      const model: Record<string, Arb> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        const fieldDef = defOf(field);
        if (fieldDef.type === 'optional') {
          model[key] = need(fieldDef['innerType']);
        } else {
          model[key] = need(field);
          required.push(key);
        }
      }
      return fc.record(model, { requiredKeys: required });
    }
    case 'record': {
      const keyDef = defOf(def['keyType']);
      const value = need(def['valueType']);
      if (keyDef.type === 'enum') {
        const keys = Object.values(keyDef['entries'] as Record<string, string>);
        const model = Object.fromEntries(keys.map((k) => [k, value]));
        return fc.record(model, { requiredKeys: def['partial'] ? [] : keys });
      }
      return fc.dictionary(need(def['keyType']) as fc.Arbitrary<string>, value, { maxKeys: depth >= MAX_LAZY_DEPTH ? 0 : 2 });
    }
    case 'template_literal':
      return fc.tuple(...(def['parts'] as unknown[]).map((part): Arb => {
        if (typeof part !== 'object' || part === null) return fc.constant(String(part));
        const partDef = defOf(part);
        if (partDef.type === 'string') return word;
        if (partDef.type === 'number') return fc.integer({ min: 0, max: 1000 });
        return need(part);
      })).map((parts) => parts.join('')).filter((v) => (schema as z.ZodType).safeParse(v).success);
    default:
      throw new Error(`no arbitrary for zod type '${def.type}'`);
  }
}

/** An arbitrary of values that `schema` accepts. */
export function valid<T>(schema: z.ZodType<T>): fc.Arbitrary<T> {
  const arb = arbitraryOf(schema);
  if (!arb) throw new Error('schema has no generatable branch');
  return arb.filter((v) => schema.safeParse(v).success) as fc.Arbitrary<T>;
}
