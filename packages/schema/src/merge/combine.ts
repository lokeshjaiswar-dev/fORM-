import type { FieldBlock } from '../v2/blocks.ts';
import type { DataClassification, FieldCompliance } from '../v2/compliance.ts';
import type { ChoiceOption } from '../v2/config.ts';
import type { FieldMessages } from '../v2/envelope.ts';
import { clone } from './clone.ts';
import { fieldMatchKey, normalizeLabel, plainLabelText } from './labels.ts';

export type CombineOk = { ok: true; field: FieldBlock; optionMap: Map<string, string> };
export type CombineFail = { ok: false; reason: string; message: string };
export type CombineResult = CombineOk | CombineFail;

const COSMETIC = new Set([
  'placeholder', 'prefix', 'suffix', 'sublabels', 'placeholders', 'rows', 'showCounter', 'searchable', 'columns',
  'shuffle', 'align', 'spacing', 'lineStyle', 'color', 'widthPct', 'href', 'image', 'collapsible', 'initiallyCollapsed',
  'title', 'description', 'text', 'subheading', 'level', 'content', 'startNewRow', 'labelAlign',
]);

const CLASS_RANK: Record<DataClassification, number> = { none: 0, personal: 1, sensitive: 2 };
const SHARE_RANK = { include: 0, mask: 1, omit: 2 } as const;

const MESSAGES: Record<string, string> = {
  'config.pattern': 'These fields use different patterns (regex) and cannot be combined.',
  'config.preset': 'These fields use different input presets and cannot be combined.',
  'config.mask': 'These fields use different input masks and cannot be combined.',
  'config.parts': 'These fields ask for different parts and cannot be combined.',
  'config.requiredParts': 'These fields require different parts and cannot be combined.',
  'config.options': 'These fields offer different choices and cannot be combined.',
  'config.display': 'These fields use different displays and cannot be combined.',
  'config.defaultValue': 'These fields have different default values and cannot be combined.',
  'config.bounds': 'These fields have limits that cannot both be true (for example min greater than max).',
  'config.unique': 'These fields use different uniqueness rules and cannot be combined.',
  'config.apiValidation': 'These fields use different API validation settings and cannot be combined.',
  'config.apiOptions': 'These fields load choices from different APIs and cannot be combined.',
  'config.messages': 'These fields have different error messages for the same error.',
  'config.description': 'These fields have different help text and cannot be combined.',
  'config.compliance.category': 'These fields are classified as different kinds of data and cannot be combined.',
  payment: 'A form can have only one payment field. Choose which payment to keep.',
  duplicate_in_source: 'The same label and type appear twice in one of the selected forms.',
  'logic.set_value': 'Both forms set this field to different values.',
  'logic.skip_to_page': 'Both forms jump from the same page to different pages.',
  'logic.skip_to_end': 'Both forms end the form from the same page in different ways.',
  'logic.set_ending': 'Both forms pick different thank-you endings.',
};

const REASON_PREFIXES = [
  'config.pattern', 'config.preset', 'config.mask', 'config.parts', 'config.requiredParts', 'config.options',
  'config.display', 'config.defaultValue', 'config.bounds', 'config.unique', 'config.apiValidation', 'config.apiOptions', 'config.messages',
  'config.description', 'config.compliance.category',
] as const;

export function canonicalReason(path: string): string {
  return REASON_PREFIXES.find((prefix) => path === prefix || path.startsWith(`${prefix}.`)) ?? path;
}

export function conflictMessage(reason: string): string {
  const code = canonicalReason(reason);
  return MESSAGES[code] ?? `These fields disagree on ${code} and cannot be combined.`;
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function optionLabel(option: ChoiceOption): string {
  return normalizeLabel(plainLabelText(option.label));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function mergeBounds(merged: Record<string, unknown>): CombineFail | null {
  const minL = merged['minLength'];
  const maxL = merged['maxLength'];
  if (typeof minL === 'number' && typeof maxL === 'number' && minL > maxL) {
    return { ok: false, reason: 'config.bounds', message: conflictMessage('config.bounds') };
  }
  const minS = merged['minSelected'];
  const maxS = merged['maxSelected'];
  if (typeof minS === 'number' && typeof maxS === 'number' && minS > maxS) {
    return { ok: false, reason: 'config.bounds', message: conflictMessage('config.bounds') };
  }
  const min = merged['min'];
  const max = merged['max'];
  if (typeof min === 'string' && typeof max === 'string' && Number(min) > Number(max)) {
    return { ok: false, reason: 'config.bounds', message: conflictMessage('config.bounds') };
  }
  const limit = asRecord(merged['limit']);
  if (limit) {
    const lo = limit['min'];
    const hi = limit['max'];
    if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) {
      return { ok: false, reason: 'config.bounds', message: conflictMessage('config.bounds') };
    }
  }
  const age = asRecord(asRecord(merged['limits'])?.['age']);
  if (age) {
    const lo = age['min'];
    const hi = age['max'];
    if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) {
      return { ok: false, reason: 'config.bounds', message: conflictMessage('config.bounds') };
    }
  }
  return null;
}

function mergeLimit(a: unknown, b: unknown, path: string): { ok: true; value: unknown } | CombineFail {
  const left = asRecord(a);
  const right = asRecord(b);
  if (!left || !right) return { ok: true, value: left ?? right };
  if (left['unit'] !== right['unit'] && left['unit'] !== undefined && right['unit'] !== undefined) {
    return { ok: false, reason: path, message: conflictMessage(path) };
  }
  const unit = left['unit'] ?? right['unit'];
  const mins = [left['min'], right['min']].filter((n): n is number => typeof n === 'number');
  const maxs = [left['max'], right['max']].filter((n): n is number => typeof n === 'number');
  const min = mins.length ? Math.max(...mins) : undefined;
  const max = maxs.length ? Math.min(...maxs) : undefined;
  return { ok: true, value: { ...left, ...right, unit, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } };
}

function mergeAge(a: unknown, b: unknown): { ok: true; value: unknown } | CombineFail {
  const left = asRecord(a);
  const right = asRecord(b);
  if (!left || !right) return { ok: true, value: left ?? right };
  const mins = [left['min'], right['min']].filter((n): n is number => typeof n === 'number');
  const maxs = [left['max'], right['max']].filter((n): n is number => typeof n === 'number');
  const min = mins.length ? Math.max(...mins) : undefined;
  const max = maxs.length ? Math.min(...maxs) : undefined;
  return { ok: true, value: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } };
}

function mergeOptions(a: unknown, b: unknown): CombineResult extends CombineFail ? never : { ok: true; value: ChoiceOption[]; optionMap: Map<string, string> } | CombineFail {
  if (!Array.isArray(a) || !Array.isArray(b)) return { ok: false, reason: 'config.options', message: conflictMessage('config.options') };
  const left = a as ChoiceOption[];
  const right = b as ChoiceOption[];
  const leftLabels = new Set(left.map(optionLabel));
  const rightLabels = new Set(right.map(optionLabel));
  if (leftLabels.size !== rightLabels.size || [...leftLabels].some((l) => !rightLabels.has(l))) {
    return { ok: false, reason: 'config.options', message: conflictMessage('config.options') };
  }
  const byLabel = new Map(left.map((o) => [optionLabel(o), o] as const));
  const optionMap = new Map<string, string>();
  for (const o of right) {
    const keep = byLabel.get(optionLabel(o));
    if (keep) optionMap.set(o.id, keep.id);
  }
  return { ok: true, value: left, optionMap };
}

function sameStringSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return equal(a, b);
  const left = [...a].map(String).sort();
  const right = [...b].map(String).sort();
  return equal(left, right);
}

function mergeConfigValue(key: string, a: unknown, b: unknown, path: string): { ok: true; value: unknown; optionMap?: Map<string, string> } | CombineFail {
  if (a === undefined) return { ok: true, value: b };
  if (b === undefined) return { ok: true, value: a };
  if (equal(a, b)) return { ok: true, value: a };
  if (COSMETIC.has(key)) return { ok: true, value: a };

  if (key === 'minLength' || key === 'minSelected') {
    if (typeof a === 'number' && typeof b === 'number') return { ok: true, value: Math.max(a, b) };
  }
  if (key === 'maxLength' || key === 'maxSelected') {
    if (typeof a === 'number' && typeof b === 'number') return { ok: true, value: Math.min(a, b) };
  }
  if (key === 'min' && typeof a === 'string' && typeof b === 'string') {
    return { ok: true, value: Number(a) >= Number(b) ? a : b };
  }
  if (key === 'max' && typeof a === 'string' && typeof b === 'string') {
    return { ok: true, value: Number(a) <= Number(b) ? a : b };
  }
  if (key === 'limit') return mergeLimit(a, b, path);
  if (key === 'options') {
    const merged = mergeOptions(a, b);
    if (!merged.ok) return merged;
    return { ok: true, value: merged.value, optionMap: merged.optionMap };
  }
  if (key === 'parts' || key === 'requiredParts' || key === 'schemes' || key === 'allowedCountries' || key === 'exclusiveOptionIds') {
    if (key === 'allowedCountries' || key === 'schemes') {
      if (Array.isArray(a) && Array.isArray(b)) {
        const set = new Set(a.filter((x) => b.includes(x)));
        if (set.size === 0) return { ok: false, reason: path, message: conflictMessage(path) };
        return { ok: true, value: [...set] };
      }
    }
    if (!sameStringSet(a, b)) return { ok: false, reason: path, message: conflictMessage(path) };
    return { ok: true, value: a };
  }
  if (key === 'allowedDomains' && Array.isArray(a) && Array.isArray(b)) {
    return { ok: true, value: [...new Set([...a, ...b].map(String))] };
  }
  if (key === 'blockFreeProviders' || key === 'blockDisposable' || key === 'confirm' || key === 'verify') {
    if (typeof a === 'boolean' && typeof b === 'boolean') return { ok: true, value: a || b };
  }
  if (key === 'limits') {
    const left = asRecord(a) ?? {};
    const right = asRecord(b) ?? {};
    const out: Record<string, unknown> = { ...left };
    for (const [k, bv] of Object.entries(right)) {
      if (k === 'age') {
        const age = mergeAge(left['age'], bv);
        if (!age.ok) return age;
        out['age'] = age.value;
        continue;
      }
      const inner = mergeConfigValue(k, left[k], bv, `${path}.${k}`);
      if (!inner.ok) return inner;
      out[k] = inner.value;
    }
    return { ok: true, value: out };
  }

  const left = asRecord(a);
  const right = asRecord(b);
  if (left && right) {
    const out: Record<string, unknown> = { ...left };
    let optionMap: Map<string, string> | undefined;
    for (const [k, bv] of Object.entries(right)) {
      const inner = mergeConfigValue(k, left[k], bv, `${path}.${k}`);
      if (!inner.ok) return { ...inner, reason: canonicalReason(inner.reason) };
      out[k] = inner.value;
      if (inner.optionMap) optionMap = inner.optionMap;
    }
    return optionMap ? { ok: true, value: out, optionMap } : { ok: true, value: out };
  }

  const reason = canonicalReason(path);
  return { ok: false, reason, message: conflictMessage(reason) };
}

function mergeMessages(a: FieldMessages | undefined, b: FieldMessages | undefined): { ok: true; value: FieldMessages | undefined } | CombineFail {
  if (!a) return { ok: true, value: b };
  if (!b) return { ok: true, value: a };
  const out: FieldMessages = { ...a };
  for (const [code, text] of Object.entries(b)) {
    const prev = out[code as keyof FieldMessages];
    if (prev !== undefined && prev !== text) {
      return { ok: false, reason: 'config.messages', message: conflictMessage('config.messages') };
    }
    out[code as keyof FieldMessages] = text;
  }
  return { ok: true, value: out };
}

function mergeCompliance(a: FieldCompliance, b: FieldCompliance): { ok: true; value: FieldCompliance } | CombineFail {
  if (a.category && b.category && a.category !== b.category) {
    return { ok: false, reason: 'config.compliance.category', message: conflictMessage('config.compliance.category') };
  }
  const classification = CLASS_RANK[a.classification] >= CLASS_RANK[b.classification] ? a.classification : b.classification;
  const share = (x: 'include' | 'mask' | 'omit', y: 'include' | 'mask' | 'omit') => (SHARE_RANK[x] >= SHARE_RANK[y] ? x : y);
  const value: FieldCompliance = {
    ...a,
    classification,
    purposeIds: [...new Set([...a.purposeIds, ...b.purposeIds])],
    encrypt: a.encrypt || b.encrypt || classification === 'sensitive',
    allowPrefill: a.allowPrefill && b.allowPrefill,
    inNotifications: share(a.inNotifications, b.inNotifications),
    inExports: share(a.inExports, b.inExports),
  };
  const category = a.category ?? b.category;
  if (category) value.category = category;
  if (a.blindIndex || b.blindIndex) value.blindIndex = true;
  const principal = a.principalIdentifier ?? b.principalIdentifier;
  if (principal) value.principalIdentifier = principal;
  return { ok: true, value };
}

function fieldSummary(block: FieldBlock): string {
  const bits: string[] = [];
  if (block.required) bits.push('required');
  const config = block.config as Record<string, unknown>;
  if (Array.isArray(config['parts'])) bits.push(`parts ${config['parts'].join(', ')}`);
  const pattern = asRecord(config['pattern']);
  if (pattern && typeof pattern['source'] === 'string') bits.push(`pattern /${pattern['source']}/`);
  if (typeof config['preset'] === 'string') bits.push(`preset ${config['preset']}`);
  if (Array.isArray(config['options'])) {
    bits.push(`choices ${(config['options'] as ChoiceOption[]).map((o) => plainLabelText(o.label)).join(', ')}`);
  }
  if (typeof config['minLength'] === 'number') bits.push(`min ${config['minLength']}`);
  if (typeof config['maxLength'] === 'number') bits.push(`max ${config['maxLength']}`);
  return bits.join(' · ') || block.type;
}

export function summarizeField(block: FieldBlock): string {
  return fieldSummary(block);
}

export function combineFields(left: FieldBlock, right: FieldBlock): CombineResult {
  if (left.type !== right.type || fieldMatchKey(left) !== fieldMatchKey(right)) {
    return { ok: false, reason: 'match', message: 'These fields are not the same question.' };
  }
  if (left.unique && right.unique && left.unique.normalize !== right.unique.normalize) {
    return { ok: false, reason: 'config.unique', message: conflictMessage('config.unique') };
  }
  if (left.apiValidation && right.apiValidation && JSON.stringify(left.apiValidation) !== JSON.stringify(right.apiValidation)) {
    return { ok: false, reason: 'config.apiValidation', message: conflictMessage('config.apiValidation') };
  }
  if (left.apiOptions && right.apiOptions && JSON.stringify(left.apiOptions) !== JSON.stringify(right.apiOptions)) {
    return { ok: false, reason: 'config.apiOptions', message: conflictMessage('config.apiOptions') };
  }
  if (left.description && right.description && plainLabelText(left.description) !== plainLabelText(right.description)) {
    return { ok: false, reason: 'config.description', message: conflictMessage('config.description') };
  }
  const messages = mergeMessages(left.messages, right.messages);
  if (!messages.ok) return messages;
  const compliance = mergeCompliance(left.compliance, right.compliance);
  if (!compliance.ok) return compliance;
  const config = mergeConfigValue('config', left.config, right.config, 'config');
  if (!config.ok) return config;
  const bounds = mergeBounds(asRecord(config.value) ?? {});
  if (bounds) return bounds;

  const field = clone(left);
  field.required = left.required || right.required;
  field.compliance = compliance.value;
  field.config = JSON.parse(JSON.stringify(config.value)) as FieldBlock['config'];
  if (left.readOnly || right.readOnly) field.readOnly = true;
  if (left.concealed || right.concealed) field.concealed = true;
  if (left.initiallyDisabled || right.initiallyDisabled) field.initiallyDisabled = true;
  if (left.initiallyHidden || right.initiallyHidden) field.initiallyHidden = true;
  if (left.hideLabel || right.hideLabel) field.hideLabel = true;
  const unique = left.unique ?? right.unique;
  if (unique) field.unique = unique;
  const apiValidation = left.apiValidation ?? right.apiValidation;
  if (apiValidation) field.apiValidation = apiValidation;
  if (left.apiOptions) field.apiOptions = left.apiOptions;
  else if (right.apiOptions) field.apiOptions = right.apiOptions;
  const prefill = left.prefill ?? right.prefill;
  if (prefill) field.prefill = prefill;
  const description = left.description ?? right.description;
  if (description) field.description = description;
  if (messages.value) field.messages = messages.value;

  return { ok: true, field, optionMap: config.optionMap ?? new Map() };
}
