type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/**
 * A partial update of `T` where an optional property may be set to `undefined` to mean "remove it". (A stored
 * definition never holds `undefined`: JSON has none, and `exactOptionalPropertyTypes` makes an optional property
 * absent-or-value.) Required properties can be replaced but not removed.
 */
export type Patch<T> = { [K in keyof T]?: K extends OptionalKeys<T> ? T[K] | undefined : T[K] };

/** `base` with `patch` applied: patched values replace, and patched `undefined` values remove the key. */
export function applyPatch<T extends object>(base: T, patch: Patch<T>): T {
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(base));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  /* Sound: `Patch<T>` only lets optional properties be removed, and every other value keeps its type. */
  return out as T;
}
