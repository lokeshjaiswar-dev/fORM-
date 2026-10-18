import { z } from 'zod';

type Check = (v: unknown) => string | null;
const checks = new WeakMap<object, Check>();

/** Runs `check` on the raw input before the structural parse; a message stops the pipe. */
export const guarded = <S extends z.ZodType>(check: Check, schema: S): z.ZodPipe<z.ZodUnknown, S> => {
  const pipe = z.unknown().superRefine((v, ctx) => {
    const message = check(v);
    if (message !== null) ctx.addIssue({ code: 'custom', message });
  }).pipe(schema);
  checks.set(pipe, check);
  return pipe;
};

/** `guarded` over every schema of a per-type map. */
export const guardedMap = <R extends Record<string, z.ZodType>>(check: Check, map: R) =>
  Object.fromEntries(Object.entries(map).map(([key, schema]) => [key, guarded(check, schema)])) as { [K in keyof R]: z.ZodPipe<z.ZodUnknown, R[K]> };

/** The pre-parse check `guarded` attached to `schema`, if any. */
export const guardOf = (schema: unknown): Check | undefined => (typeof schema === 'object' && schema !== null ? checks.get(schema) : undefined);

/** zod skips an own `__proto__` key of a record or loose object without an issue; this turns the silent drop into one. */
export const ownProtoKey = (v: unknown): string | null =>
  typeof v === 'object' && v !== null && Object.prototype.hasOwnProperty.call(v, '__proto__') ? "'__proto__' is not allowed as a key" : null;

/** Every record and loose object goes through here, so no key is ever dropped while the parse succeeds. */
export const keyed = <S extends z.ZodType>(schema: S) => guarded(ownProtoKey, schema);

/** Iterative, so hostile nesting never reaches zod's recursive parse. */
export function exceedsDepth(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  for (let item = stack.pop(); item; item = stack.pop()) {
    const [v, depth] = item;
    if (typeof v !== 'object' || v === null) continue;
    if (depth > max) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

/** JSON nesting bound for the recursive logic types (Expr, ConditionGroup, ScalarValue, StoredAnswer). */
export const MAX_JSON_DEPTH = 256;
export const depthGuard = (v: unknown): string | null => (exceedsDepth(v, MAX_JSON_DEPTH) ? `nested deeper than ${MAX_JSON_DEPTH}` : null);

export const RICH_TEXT_LIMITS = { maxNodes: 20_000, maxDepth: 8, maxListDepth: 3 } as const;

export interface RichTextMeasure { nodes: number; depth: number; listDepth: number }

/** Counts nodes reachable through `content` arrays; the doc itself is depth 0. Stops early past the limits. */
export function measureRichText(doc: unknown): RichTextMeasure {
  const out: RichTextMeasure = { nodes: 0, depth: 0, listDepth: 0 };
  const stack: Array<[unknown, number, number]> = [[doc, 0, 0]];
  for (let item = stack.pop(); item; item = stack.pop()) {
    const [node, depth, lists] = item;
    if (typeof node !== 'object' || node === null) continue;
    const content = (node as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const child of content) {
      out.nodes += 1;
      const type = typeof child === 'object' && child !== null ? (child as { type?: unknown }).type : undefined;
      const childLists = type === 'bulletList' || type === 'orderedList' ? lists + 1 : lists;
      out.depth = Math.max(out.depth, depth + 1);
      out.listDepth = Math.max(out.listDepth, childLists);
      if (out.nodes > RICH_TEXT_LIMITS.maxNodes || out.depth > RICH_TEXT_LIMITS.maxDepth) return out;
      stack.push([child, depth + 1, childLists]);
    }
  }
  return out;
}

export function richTextLimitError(doc: unknown): string | null {
  const m = measureRichText(doc);
  if (m.nodes > RICH_TEXT_LIMITS.maxNodes) return `rich text has more than ${RICH_TEXT_LIMITS.maxNodes} nodes`;
  if (m.depth > RICH_TEXT_LIMITS.maxDepth) return `rich text is nested deeper than ${RICH_TEXT_LIMITS.maxDepth}`;
  if (m.listDepth > RICH_TEXT_LIMITS.maxListDepth) return `lists are nested deeper than ${RICH_TEXT_LIMITS.maxListDepth}`;
  return null;
}

/** Builds `{ [K]: { type: K, value: shape[K] } }` for type-tagged unions (answers). */
export function tagged<S extends Record<string, z.ZodType>>(shape: S): { [K in keyof S & string]: z.ZodObject<{ type: z.ZodLiteral<K>; value: S[K] }, z.core.$strip> } {
  return Object.fromEntries(Object.entries(shape).map(([type, value]) => [type, z.object({ type: z.literal(type), value })])) as never;
}

/** Non-empty tuple of a record's values, for z.discriminatedUnion. */
export const options = <R extends Record<string, z.core.$ZodTypeDiscriminable>>(record: R) =>
  Object.values(record) as [R[keyof R], ...Array<R[keyof R]>];
