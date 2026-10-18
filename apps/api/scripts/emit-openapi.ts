import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';

/** Writes the internal OpenAPI document without a database (the pool never connects). */
const out = path.resolve(process.argv[2] ?? 'dist/openapi.json');
const parsed = parseConfig({ NODE_ENV: 'production', LOG_LEVEL: 'silent', DEPLOYMENT_MODE: 'onprem', DATABASE_URL: 'postgres://openapi@127.0.0.1:1/openapi' });
if (!parsed.ok) throw new Error(parsed.errors.join('\n'));

const app = await buildApp(parsed.config);
await app.ready();
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
process.stdout.write(`openapi: wrote ${out}\n`);
