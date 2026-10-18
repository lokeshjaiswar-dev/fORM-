import { toPlain } from '@form/schema';
import type {
  FieldKey, FormId, FormTemplateBinding, InstantiateContext, Locale, Origin, OrgId, StoredBlock, TemplateBindingId, TemplateKind, TemplateRef, TemplateVariable,
  TemplateVariableName, TemplateVersion, TemplateWarning, UserId,
} from '@form/schema';
import { isOpaque, isRec, mapKey, remapOf, type IdNamespace, type Remap } from './remap.ts';
import { uuidv5 } from './uuid.ts';
import { bakeVariables, resolveVariables } from './variables.ts';

/** Who applies a template. The API passes the request's org and user; the offline builder has neither yet. */
export interface Actor { orgId: OrgId; userId: UserId }

/** Typed stand-in for the offline builder (no org, no user): the API re-runs `instantiate` and writes the real binding rows. */
export const OFFLINE_ACTOR: Actor = { orgId: 'offline' as OrgId, userId: 'offline' as UserId };

/** Options beyond the §19 signature; `instantiate(version, ctx)` alone is a valid `Instantiate`. */
export interface EngineOptions {
  /** Looks up `refs` given as a `TemplateRef` (a pack or the template store). Unresolved refs are skipped with a warning. */
  resolveRef?: (ref: TemplateRef) => TemplateVersion | undefined;
  actor?: Actor;
  /**
   * The form's template bindings. `insertSnippet` uses them to recognise an earlier insert of a once-per-form
   * snippet (a snippet binding of the same template whose root is still in the form). Without them it falls
   * back to a block of the root's type stamped with the root's source id, which may also match another template.
   */
  bindings?: readonly FormTemplateBinding[];
}

/** `sourceId` of the one item a theme, ending, email, PDF or workflow template applies (its payload has no id). */
export const ROOT_SOURCE_ID = '$root';

/** Deterministic ids for one binding: `uuidv5(namespace, mapKey(ns, sourceId))`, recorded in `idMap`. */
export class IdAllocator {
  readonly idMap: Record<string, string> = {};
  private readonly namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  alloc(ns: IdNamespace, sourceId: string): string {
    const key = mapKey(ns, sourceId);
    const existing = this.idMap[key];
    if (existing !== undefined) return existing;
    const id = uuidv5(this.namespace, key);
    this.idMap[key] = id;
    return id;
  }

  /** An id for an item the payload does not name (a ref's ending, notification, PDF); `name` contains '/' so it never meets a source id. */
  named(name: string): string {
    return uuidv5(this.namespace, name);
  }

  remap(keyMap?: Readonly<Record<string, string>>): Remap {
    return remapOf(this.idMap, keyMap);
  }
}

/** Condition and condition-group ids anywhere in `value` (unique per definition, so they are remapped too). */
export function conditionIds(value: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i -= 1) stack.push(v[i]);
      continue;
    }
    if (!isRec(v)) continue;
    if ((v['kind'] === 'condition' || v['kind'] === 'group') && typeof v['id'] === 'string' && !out.includes(v['id'])) out.push(v['id']);
    const entries = Object.entries(v).filter(([k]) => !isOpaque(v, k));
    for (let i = entries.length - 1; i >= 0; i -= 1) stack.push(entries[i]?.[1]);
  }
  return out;
}

const KEY_MAX = 64;

/** `key`, or the first free `key_2`, `key_3` … (shortened to stay a FieldKey). */
export function uniqueKey(key: string, taken: ReadonlySet<string>): string {
  if (!taken.has(key)) return key;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = key.slice(0, KEY_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export const origin = (bindingId: string, sourceId: string): Origin => ({ bindingId: bindingId as TemplateBindingId, sourceId });

export function binding(
  id: string, kind: TemplateKind, version: TemplateVersion, formId: FormId, actor: Actor, now: InstantiateContext['now'],
  idMap: Record<string, string>, extra: { instanceRootId?: string; keyMap?: Record<string, FieldKey> } = {},
): FormTemplateBinding {
  return {
    id: id as TemplateBindingId,
    orgId: actor.orgId,
    formId,
    templateId: version.templateId,
    templateVersionId: version.id,
    kind,
    ...(extra.instanceRootId !== undefined ? { instanceRootId: extra.instanceRootId } : {}),
    idMap,
    ...(extra.keyMap !== undefined ? { keyMap: extra.keyMap } : {}),
    updateState: 'current',
    governance: 'bound',
    appliedBy: actor.userId,
    appliedAt: now,
  };
}

/** "This template contains sensitive fields (PAN); encryption is on by default." */
export function sensitiveWarning(blocks: Iterable<StoredBlock>): TemplateWarning[] {
  const labels: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'unsupported' && 'compliance' in block && block.compliance.classification === 'sensitive') labels.push(toPlain(block.label) || block.key);
  }
  return labels.length ? [{ code: 'sensitive_fields', message: `This template contains sensitive fields (${labels.join(', ')}); encryption is on by default.` }] : [];
}

type BakeContext = Pick<InstantiateContext, 'orgProfile' | 'brandKit' | 'variables'> & { formTitle: string };

/** Bakes variables per locale (org-profile text is per locale) and collects what stayed unresolved. */
export class Baker {
  private readonly declared: readonly TemplateVariable[];
  private readonly ctx: BakeContext;
  private readonly used: readonly TemplateVariableName[];
  private readonly byLocale = new Map<string, ReturnType<typeof resolveVariables>>();
  private readonly unresolved = new Set<TemplateVariableName>();

  constructor(declared: readonly TemplateVariable[], ctx: BakeContext, used: readonly TemplateVariableName[]) {
    this.declared = declared;
    this.ctx = ctx;
    this.used = used;
  }

  private resolved(locale: Locale) {
    let r = this.byLocale.get(locale);
    if (!r) {
      r = resolveVariables(this.declared, { ...this.ctx, locale }, this.used);
      this.byLocale.set(locale, r);
    }
    return r;
  }

  bake<T>(value: T, locale: Locale): T {
    const r = this.resolved(locale);
    const baked = new Set([...Object.keys(r.values), ...r.missing.map((m) => m.name)]);
    const out = bakeVariables(value, (name) => baked.has(name), (name) => r.values[name]);
    out.unresolved.forEach((name) => this.unresolved.add(name));
    return out.value;
  }

  /** `variable_missing` for every required `bake` variable without a value, and every one left as a placeholder. */
  warnings(locale: Locale): TemplateWarning[] {
    return this.resolved(locale).missing
      .filter((m) => m.required || this.unresolved.has(m.name))
      .map((m) => ({ code: 'variable_missing', message: `Template variable '${m.name}' has no value${this.unresolved.has(m.name) ? '; its placeholder stays in the form' : ''}`, at: m.name }));
  }
}

