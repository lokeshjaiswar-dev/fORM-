/** Merge a patch that may use `undefined` to clear a key, without assigning `undefined` onto an exact optional property. */
export function applyPatch<T extends object>(base: T, patch: { [K in keyof T]?: T[K] | undefined }): T {
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}
