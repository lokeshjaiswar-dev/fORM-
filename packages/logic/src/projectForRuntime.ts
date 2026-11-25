import type { ApiLookup, BlockId, ClientAction, FormDefinition, PublicLookup, ProjectForRuntime, PublicFormDefinition, Rule, RuntimeFormVersion } from '@form/schema';
import { isClientAction } from './analyze.ts';
import { stepKey } from './cells.ts';

/** An `Origin` stamp: exactly `{ bindingId, sourceId }` (a block or option whose id is 'origin' is not one). */
const isOrigin = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).sort().join() === 'bindingId,sourceId';

/** Drops every `origin` stamp at any depth; TranslationEntry.origin is a string and stays. */
function stripOrigins<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripOrigins) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, v]) => (key === 'origin' && isOrigin(v) ? [] : [[key, stripOrigins(v)]]))) as T;
}

/**
 * Server-side lookups: the respondent never sends the upstream request, so nothing of it reaches the runtime
 * projection. A field's `apiOptions` / `apiValidation` shrink to `{ remote: true }` (the proxy finds the request in the
 * stored version), and a lookup shrinks to its picker, key, field mapping and limits. Credentials (`auth` of a version
 * published before the publish check, `credentialRef`), the URL, the query, `itemsPath`, `searchParam` and every response
 * key stay on the server (T-LK-01). The author's failure text for a check is the block's own `messages.api_failed`.
 */
export const LOOKUP_DEFAULT_MIN_CHARS = 2;
export const LOOKUP_DEFAULT_MAX_ROWS = 20;

function publicLookup(lookup: ApiLookup, fallbackId: string, hasBlock: (id: string) => boolean): PublicLookup | undefined {
  if (lookup.enabled !== true || !lookup.pickerFieldId || !lookup.pickerKey || !hasBlock(lookup.pickerFieldId)) return undefined;
  const dms = lookup.source === 'dms_master';
  const id = lookup.id ?? fallbackId;
  const mappings = (lookup.mappings ?? []).flatMap((m): Array<{ key: string; fieldId: BlockId }> =>
    m.fieldId !== undefined && hasBlock(m.fieldId) ? [{ key: m.key, fieldId: m.fieldId }] : []);
  const rowCap = dms ? 20 : 50;
  return {
    id,
    source: dms ? 'dms_master' : 'http',
    ...(lookup.name !== undefined ? { name: lookup.name } : {}),
    pickerFieldId: lookup.pickerFieldId,
    pickerKey: lookup.pickerKey,
    mappings,
    minChars: lookup.minChars ?? LOOKUP_DEFAULT_MIN_CHARS,
    maxRows: Math.min(lookup.maxRows ?? LOOKUP_DEFAULT_MAX_ROWS, rowCap),
    ...(dms ? { masterId: lookup.masterId } : {}),
  };
}

/** Rules keep only client actions; a rule left with no actions is dropped. */
function clientRules(rules: readonly Rule[]): Array<Rule<ClientAction>> {
  return rules.flatMap((rule) => {
    const then = rule.then.filter(isClientAction);
    const otherwise = rule.else?.filter(isClientAction);
    if (!then.length && !otherwise?.length) return [];
    const { else: _else, ...rest } = rule;
    return [otherwise?.length ? { ...rest, then, else: otherwise } : { ...rest, then }];
  });
}

/**
 * The runtime projection (I11): no builder notes, origin stamps or server actions; the compiled form
 * keeps `reads` for incremental evaluation but only for the steps of rules it keeps, and drops `dataInventory`, `taint`, `ruleWrites`,
 * `reviewUnits` and `reviewUnitMarkers`; `review` shrinks to unit ids and names.
 */
export const projectForRuntime: ProjectForRuntime = (version, status, publicConfig) => {
  const def = version.definition as FormDefinition;
  const blocks = Object.fromEntries(Object.entries(def.blocks).map(([id, block]) => {
    if (!block || block.type === 'unsupported') return [id, block];
    const { note: _note, ...rest } = block;
    const { apiOptions, apiValidation, ...field } = rest as typeof rest & { apiOptions?: unknown; apiValidation?: unknown };
    return [id, {
      ...field,
      ...(apiOptions !== undefined ? { apiOptions: { remote: true } } : {}),
      ...(apiValidation !== undefined ? { apiValidation: { remote: true } } : {}),
    }];
  }));
  const hasBlock = (blockId: string) => {
    const b = def.blocks[blockId as BlockId];
    return b !== undefined && b.type !== 'unsupported';
  };
  /* The legacy singular `lookup` is folded in last, under the id 'lookup' when it has none (a listed lookup wins an id clash). */
  const listed = (def.lookups ?? []).flatMap((l) => publicLookup(l, '', hasBlock) ?? []);
  const legacy = def.lookup ? publicLookup(def.lookup, 'lookup', hasBlock) : undefined;
  const lookups = {
    ...(listed.length || legacy ? { lookups: [...listed, ...(legacy && !listed.some((l) => l.id === legacy.id) ? [legacy] : [])] } : {}),
  };
  const rules = clientRules(def.logic.rules);
  /* WP-2.33: the respondent gets each review unit's id and name, never its target (page or block ids), group or visibility. */
  const { review, lookup: _lookup, lookups: _lookups, ...rest } = def;
  const publicReview = review ? { review: { units: review.units.map((unit) => ({ id: unit.id, name: unit.name })) } } : {};
  const definition = stripOrigins({ ...rest, ...publicReview, ...lookups, blocks, logic: { ...def.logic, rules } }) as PublicFormDefinition;
  const { dataInventory: _inventory, taint: _taint, reviewUnits: _reviewUnits, reviewUnitMarkers: _reviewUnitMarkers, ruleWrites: _ruleWrites, plan, reads, ...compiled } = version.compiled;
  /* Steps of dropped rules go too: server-only rules, and rules with no actions at all. */
  const kept = new Set<string>(rules.map((r) => r.id));
  const clientPlan = plan.filter((step): step is Exclude<typeof step, { scope: 'server' }> =>
    step.kind !== 'rule' || (step.scope !== 'server' && kept.has(step.ruleId)));
  const clientReads = Object.fromEntries(clientPlan.flatMap((step) => {
    const key = stepKey(step);
    const cells = reads[key];
    return cells ? [[key, cells]] : [];
  }));
  const runtime: RuntimeFormVersion = {
    versionId: version.id,
    formId: version.formId,
    contentHash: version.contentHash,
    definition,
    compiled: { ...compiled, plan: clientPlan, reads: clientReads },
    status,
    publicConfig,
  };
  return runtime;
};
