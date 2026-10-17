import path from 'node:path';
import { REPO_ROOT, extract } from './extractor.ts';

const check = process.argv.includes('--check');
const { errors, stale } = extract({ check });
const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
if (check && stale.length) {
  console.error(`Out of date: ${stale.map(rel).join(', ')}. Run \`pnpm i18n:extract\`.`);
  process.exit(1);
}
console.log(stale.length ? `Updated ${stale.map(rel).join(', ')}` : 'Catalogues are up to date.');
