import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import type { PackSource } from '../src/index.ts';
import { SYSTEM_CORE_DIR, loadPackSource } from '../scripts/source.ts';

export const systemCore = (): PackSource => loadPackSource(SYSTEM_CORE_DIR);

export const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** A pack source of one template file (the system-core categories). */
export function single(file: unknown, slug = 'core/fixture'): PackSource {
  const core = systemCore();
  return { ...core, templates: [{ slug, version: 1, file }] };
}

/** Rewrites a pack's files and zips it again (no re-signing). */
export function rezip(pack: Uint8Array, edit: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(pack);
  edit(files);
  return zipSync(files);
}

/** A copy of `value` with each JSON pointer set (the last segment may be a new array index). */
export function edit(value: unknown, changes: Record<string, unknown>): unknown {
  const out: unknown = structuredClone(value);
  for (const [pointer, next] of Object.entries(changes)) {
    const keys = pointer.split('/').slice(1);
    const last = keys.pop() ?? '';
    let node = out as Record<string, unknown>;
    for (const key of keys) node = node[key] as Record<string, unknown>;
    node[last] = next;
  }
  return out;
}

export const flipByte =(bytes: Uint8Array, at: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  out[at] = (out[at] ?? 0) ^ 0x01;
  return out;
};
