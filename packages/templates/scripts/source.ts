import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTESTATIONS_PATH, CATEGORIES_PATH, PackDescriptorSchema, type PackSource } from '../src/index.ts';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SYSTEM_CORE_DIR = path.join(PACKAGE_ROOT, 'src', 'system', 'core');

const json = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** Reads a pack directory: `pack.json`, `categories.json`, optional `attestations.json`, and each template source it lists. */
export function loadPackSource(dir: string): PackSource {
  const { templates, ...pack } = PackDescriptorSchema.parse(json(path.join(dir, 'pack.json')));
  const attestations = path.join(dir, ATTESTATIONS_PATH);
  return {
    pack,
    templates: templates.map((t) => ({ slug: t.slug, version: t.version, file: json(path.join(dir, t.source)) })),
    categories: json(path.join(dir, CATEGORIES_PATH)),
    ...(existsSync(attestations) ? { attestations: json(attestations) } : {}),
  };
}
