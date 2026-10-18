import { canonicalJson } from '@form/schema';
import type { BrandKit, Locale, OrgProfile, OrgProfileTextField, PostalAddress, TemplateVariable, TemplateVariableName } from '@form/schema';
import { isOpaque, isRec, type Rec } from './remap.ts';

/** What `bake` variables resolve against when a template is used (templates spec §3.2). */
export interface VariableContext {
  locale: Locale;
  orgProfile: OrgProfile | null;
  brandKit: BrandKit | null;
  /** Answers from the Use dialog (`custom.*`). */
  variables: Partial<Record<TemplateVariableName, string | number | boolean>>;
  formTitle?: string;
}

export interface ResolvedVariables {
  /** Values of the `bake` variables that resolved, as the text that replaces their nodes. */
  values: Partial<Record<TemplateVariableName, string>>;
  /** `bake` variables with no value from the context, the org profile, the brand kit or a declared default. */
  missing: Array<{ name: TemplateVariableName; required: boolean }>;
}

/** Declared binding, else the spec default: prompts (`custom.*`) bake, org/brand/form variables stay live. */
export const bindingOf = (name: string, declared?: TemplateVariable): 'live' | 'bake' => declared?.binding ?? (name.startsWith('custom.') ? 'bake' : 'live');

const address = (a: PostalAddress | undefined): string | undefined =>
  a && [a.line1, a.line2, a.city, `${a.state} ${a.postalCode}`, a.country].filter((part) => part !== undefined && part !== '').join(', ');

type OrgGetter = (p: OrgProfile) => string | undefined;
const ORG_VALUES: Readonly<Record<string, readonly [OrgGetter, OrgProfileTextField?]>> = {
  'org.display_name': [(p) => p.displayName, 'display_name'],
  'org.legal_name': [(p) => p.legalName, 'legal_name'],
  'org.cin': [(p) => p.cin],
  'org.gstin': [(p) => p.gstin],
  'org.registered_address': [(p) => address(p.registeredAddress), 'registered_address'],
  'org.website': [(p) => p.website],
  'org.support_email': [(p) => p.supportEmail],
  'org.support_phone': [(p) => p.supportPhone],
  'org.privacy_policy_url': [(p) => p.privacyPolicyUrl],
  'org.terms_url': [(p) => p.termsUrl],
  'org.rights_url': [(p) => p.rightsUrl],
  'org.board_complaint_info': [(p) => p.boardComplaintInfo, 'board_complaint_info'],
  'org.privacy_contact.name': [(p) => p.privacyContact?.name, 'privacy_contact.name'],
  'org.privacy_contact.designation': [(p) => p.privacyContact?.designation, 'privacy_contact.designation'],
  'org.privacy_contact.email': [(p) => p.privacyContact?.email],
  'org.privacy_contact.phone': [(p) => p.privacyContact?.phone],
  'org.privacy_contact.address': [(p) => address(p.privacyContact?.address), 'privacy_contact.address'],
  'org.dpo.name': [(p) => p.dpo?.name, 'dpo.name'],
  'org.dpo.email': [(p) => p.dpo?.email],
  'org.dpo.phone': [(p) => p.dpo?.phone],
};

type BrandGetter = (k: BrandKit['tokens']) => string | undefined;
const BRAND_VALUES: Readonly<Record<string, BrandGetter>> = {
  'brand.primary': (k) => k.colors.primary,
  'brand.secondary': (k) => k.colors.secondary,
  'brand.accent': (k) => k.colors.accent,
  'brand.background': (k) => k.colors.background,
  'brand.surface': (k) => k.colors.surface,
  'brand.text': (k) => k.colors.text,
  'brand.muted': (k) => k.colors.muted,
  'brand.error': (k) => k.colors.error,
  'brand.success': (k) => k.colors.success,
  'brand.logo': (k) => k.logos.primary,
  'brand.logo_dark': (k) => k.logos.dark,
  'brand.logo_square': (k) => k.logos.square,
  'brand.favicon': (k) => k.logos.favicon,
  'brand.font_heading': (k) => k.typography.heading,
  'brand.font_body': (k) => k.typography.body,
  'brand.radius': (k) => k.shape.radius,
};

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/** The org-profile value of an `org.*` variable in `locale` (the per-locale text, else the base field). */
export function orgValue(name: string, profile: OrgProfile, locale: Locale): string | undefined {
  const entry = ORG_VALUES[name];
  if (!entry) return undefined;
  const [get, localized] = entry;
  return nonEmpty(localized ? profile.localized[locale]?.[localized] : undefined) ?? nonEmpty(get(profile));
}

function valueOf(name: TemplateVariableName, declared: TemplateVariable | undefined, ctx: VariableContext): string | undefined {
  const source = declared?.source ?? (name.startsWith('org.') ? 'org_profile' : name.startsWith('brand.') ? 'brand_kit' : name.startsWith('form.') ? 'form' : 'prompt');
  let value: string | number | boolean | undefined;
  if (source === 'prompt') value = ctx.variables[name];
  else if (source === 'org_profile') value = ctx.orgProfile ? orgValue(name, ctx.orgProfile, ctx.locale) : undefined;
  else if (source === 'brand_kit') value = ctx.brandKit ? nonEmpty(BRAND_VALUES[name]?.(ctx.brandKit.tokens)) : undefined;
  else value = name === 'form.title' ? nonEmpty(ctx.formTitle) : undefined;
  value ??= declared?.default;
  return value === undefined ? undefined : String(value);
}

/**
 * `resolveVariables(bake)`: the values of every `bake` variable among `variables` and `used` (names found in
 * the content; an undeclared `custom.*` name bakes). Live variables are left to the builder and to publish.
 */
export function resolveVariables(variables: readonly TemplateVariable[], ctx: VariableContext, used: Iterable<TemplateVariableName> = []): ResolvedVariables {
  const declared = new Map<string, TemplateVariable>();
  for (const v of variables) if (!declared.has(v.name)) declared.set(v.name, v);
  const names: TemplateVariableName[] = [];
  for (const name of [...variables.map((v) => v.name), ...used]) if (!names.includes(name)) names.push(name);
  const out: ResolvedVariables = { values: {}, missing: [] };
  for (const name of names) {
    const decl = declared.get(name);
    if (bindingOf(name, decl) !== 'bake') continue;
    const value = valueOf(name, decl, ctx);
    if (value === undefined) out.missing.push({ name, required: decl?.required ?? false });
    else out.values[name] = value;
  }
  return out;
}

const isVarNode = (v: unknown): v is { type: 'var'; attrs: { name: TemplateVariableName; fallback?: string } } =>
  isRec(v) && v['type'] === 'var' && isRec(v['attrs']) && typeof v['attrs']['name'] === 'string';
const isPlainVar = (v: unknown): v is { var: { name: TemplateVariableName; fallback?: string } } =>
  isRec(v) && Object.keys(v).length === 1 && isRec(v['var']) && typeof v['var']['name'] === 'string';

/** Every template variable name used in `value` (rich-text `var` nodes and `{ var }` items of plain templates). */
export function variableNames(value: unknown): TemplateVariableName[] {
  const names: TemplateVariableName[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!isRec(v)) return;
    const name = isVarNode(v) ? v.attrs.name : isPlainVar(v) ? v.var.name : undefined;
    if (name !== undefined && !names.includes(name)) names.push(name);
    for (const [k, child] of Object.entries(v)) if (!isOpaque(v, k)) visit(child);
  };
  visit(value);
  return names;
}

const sameMarks = (a: Rec, b: Rec): boolean => canonicalJson(a['marks'] ?? []) === canonicalJson(b['marks'] ?? []);

/** Adjacent text nodes with the same marks become one; adjacent strings of a plain template too; empty ones go. */
export function mergeRuns(items: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (typeof item === 'string') {
      if (item === '') continue;
      if (typeof last === 'string') out[out.length - 1] = last + item;
      else out.push(item);
    } else if (isRec(item) && item['type'] === 'text' && typeof item['text'] === 'string') {
      if (item['text'] === '') continue;
      if (isRec(last) && last['type'] === 'text' && typeof last['text'] === 'string' && sameMarks(last, item)) out[out.length - 1] = { ...last, text: last['text'] + item['text'] };
      else out.push(item);
    } else out.push(item);
  }
  return out;
}

/**
 * Substitutes baked variables in `value`: a rich-text `var` node becomes a text node, a plain-template
 * `{ var }` item a string. `valueFor` returns the text of a baked name (undefined for a live variable, or a
 * baked one with no value: its `fallback` is used when it has one, otherwise the node stays and the name is
 * reported as unresolved).
 */
export function bakeVariables<T>(value: T, isBaked: (name: TemplateVariableName) => boolean, valueFor: (name: TemplateVariableName) => string | undefined): { value: T; unresolved: TemplateVariableName[] } {
  const unresolved: TemplateVariableName[] = [];
  const text = (name: TemplateVariableName, fallback: string | undefined): string | undefined => {
    if (!isBaked(name)) return undefined;
    const resolved = valueFor(name) ?? fallback;
    if (resolved === undefined && !unresolved.includes(name)) unresolved.push(name);
    return resolved;
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let changed = false;
      const items = v.map((item: unknown) => {
        if (isVarNode(item)) {
          const t = text(item.attrs.name, item.attrs.fallback);
          if (t === undefined) return walk(item);
          changed = true;
          return { type: 'text', text: t };
        }
        if (isPlainVar(item)) {
          const t = text(item.var.name, item.var.fallback);
          if (t === undefined) return walk(item);
          changed = true;
          return t;
        }
        return walk(item);
      });
      return changed ? mergeRuns(items) : items;
    }
    if (!isRec(v)) return v;
    const out: Rec = {};
    for (const [k, child] of Object.entries(v)) out[k] = isOpaque(v, k) ? child : walk(child);
    return out;
  };
  return { value: walk(value) as T, unresolved };
}
