import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nginxHeaders, productionHeaderSets } from './headers.ts';

/*
 * `node security/render-nginx.ts <outDir>`: writes the two nginx header include files of a deployment, from the build's
 * environment (VITE_API_URL, VITE_FP_DMS_API_ORIGINS, VITE_FP_DMS_API_BASE, VITE_FP_EMBED_PARENTS, FP_PUBLIC_ORIGINS,
 * VITE_FP_LEGACY_DESCRIPTOR; the FP_* names of `headers:nginx` also work). The Dockerfile runs it at build time;
 * deploy/nginx.conf.template includes them:
 *   plain.conf       every route (frame-ancestors 'none', X-Frame-Options DENY): the SPA
 *   embed-page.conf  /embed/dms-master, /embed/dms-record (full-page launches: plain, without report-uri: no receiver on DMS hosts)
 *   upload.conf      /embed/dms-upload only: the sandboxed set (CSP `sandbox`, connect-src 'none', no report-uri, no-store) in the default
 *                    build; today's framable set (no report-uri) in the M2 legacy build (VITE_FP_LEGACY_DESCRIPTOR=1)
 * nginx does not inherit add_header into a block that sets its own, so the template includes the right file in every location.
 */
const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: node security/render-nginx.ts <outDir>\n');
  process.exit(2);
}
const sets = productionHeaderSets(process.env);
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'plain.conf'), `${nginxHeaders(sets.plain)}\n`);
writeFileSync(path.join(out, 'embed-page.conf'), `${nginxHeaders(sets.embedPage)}\n`);
writeFileSync(path.join(out, 'upload.conf'), `${nginxHeaders(sets.upload)}\n`);
