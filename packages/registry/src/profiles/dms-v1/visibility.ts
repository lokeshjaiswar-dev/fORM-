import type { StoredBlock } from '@form/schema';
import { X_DMS, xDms } from './shared.ts';
import type { DmsElement } from './types.ts';

/*
 * Hidden and secret fields (run dmsplus-int, SEC-DESIGN 5.2-5.3, DESIGN 5.2).
 *
 * dms-api keeps `is_hidden` / `is_secret` per master field and returns them on every element of `GET v1/master/form/{id}`. fORM- does
 * not model them as block settings: they are first-class keys of the block's `x-dms` record. "First-class" here means:
 *   - they are read as booleans (a stored 0/1/"true"/"false" is normalised once, on load; null and absence mean "not set");
 *   - a block that carries them writes them back exactly as read, so a non-revealer who echoes what it was given changes nothing
 *     (the server answers 403 FIELD_VISIBILITY_FORBIDDEN for a different value);
 *   - the inspector toggles (`DmsVisibilitySettings`) set both keys together, so a changed block always writes an explicit pair;
 *   - the guard refuses a primary field that is hidden or secret (PRIMARY_CANNOT_BE_HIDDEN on the server).
 * A block that never had either key writes neither: the canonical create fixture stays byte for byte what it was.
 */

export const IS_HIDDEN = 'is_hidden';
export const IS_SECRET = 'is_secret';
export const VISIBILITY_KEYS: readonly string[] = [IS_HIDDEN, IS_SECRET];

export interface DmsVisibility {
  hidden: boolean;
  secret: boolean;
}

const TRUE = new Set(['1', 'true']);
const FALSE = new Set(['0', 'false']);

/** A stored flag as a boolean; `undefined` for an absent, null or unreadable one. */
export function flagOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return TRUE.has(v) ? true : FALSE.has(v) ? false : undefined;
  }
  return undefined;
}

/** The two flags of a DMS element; a flag the element does not carry is `false`. */
export function visibilityOfElement(element: Pick<DmsElement, 'is_hidden' | 'is_secret'>): DmsVisibility {
  return { hidden: flagOf(element.is_hidden) === true, secret: flagOf(element.is_secret) === true };
}

/** The two flags a block carries in `x-dms`; a flag the block does not carry is `false`. */
export function visibilityOfBlock(block: StoredBlock): DmsVisibility {
  const dms = xDms(block);
  return { hidden: flagOf(dms[IS_HIDDEN]) === true, secret: flagOf(dms[IS_SECRET]) === true };
}

/** True when the block is hidden or secret. */
export const isRestricted = (block: StoredBlock): boolean => {
  const v = visibilityOfBlock(block);
  return v.hidden || v.secret;
};

/**
 * The `x` record a block must carry after `patch` is applied to its flags: every other key of `x` and of `x-dms` is untouched, and both
 * flags are written (the one not in `patch` keeps its value, `false` when it had none).
 */
export function xWithVisibility(block: StoredBlock, patch: Partial<DmsVisibility>): Record<string, unknown> {
  const x = 'x' in block && typeof block.x === 'object' && block.x !== null ? (block.x as Record<string, unknown>) : {};
  const now = visibilityOfBlock(block);
  return {
    ...x,
    [X_DMS]: { ...xDms(block), [IS_HIDDEN]: patch.hidden ?? now.hidden, [IS_SECRET]: patch.secret ?? now.secret },
  };
}

/** The normalised flags of an element, for the keys it actually carries (null and unreadable values are dropped). */
export function flagsOfElement(element: DmsElement): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of VISIBILITY_KEYS) {
    const flag = flagOf(element[key]);
    if (flag !== undefined) out[key] = flag;
  }
  return out;
}
