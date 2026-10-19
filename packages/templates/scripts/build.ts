import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildFormpack, type BuildIssue } from '../src/index.ts';
import { signerFromEnv } from './signer.ts';
import { PACKAGE_ROOT, SYSTEM_CORE_DIR, loadPackSource } from './source.ts';

/* `pnpm templates:build`: validates src/system/core and writes dist/system-core-<version>.formpack. */

const show = (i: BuildIssue) => `${i.at}${i.path ? ` ${i.path}` : ''}: ${i.code}: ${i.message}`;

const signer = signerFromEnv();
const result = await buildFormpack(loadPackSource(SYSTEM_CORE_DIR), signer);
for (const warning of result.warnings) console.warn(`warning ${show(warning)}`);
if (!result.ok) {
  for (const issue of result.issues) console.error(`error ${show(issue)}`);
  console.error(`templates:build failed with ${result.issues.length} error(s).`);
  process.exit(1);
}
const dist = path.join(PACKAGE_ROOT, 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(path.join(dist, result.fileName), result.bytes);
console.log(`Wrote dist/${result.fileName}: ${result.manifest.templates.length} templates, ${result.bytes.byteLength} bytes, signed by ${signer.keyId}.`);
