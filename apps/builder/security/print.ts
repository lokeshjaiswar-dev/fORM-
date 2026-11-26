import { deployEnv, nginxHeaders, productionHeaderSets } from './headers.ts';

/*
 * `pnpm --filter @form/builder headers:nginx`: the production builder headers for this deployment's PUBLIC_API_URL.
 * The VITE_* build names (VITE_API_URL, VITE_FP_DMS_API_ORIGINS, VITE_FP_DMS_API_BASE, VITE_FP_EMBED_PARENTS) work as well as the FP_* ones.
 * With FP_EMBED_PARENTS (comma separated origins that may frame `/embed/dms-upload`, e.g. the DMS+ origin) it also prints the
 * lines of the `/embed/dms-upload` location: the sandboxed set (FP_PUBLIC_ORIGINS, default the parents, names this deployment's own
 * origin beside 'self'), or today's framable set when VITE_FP_LEGACY_DESCRIPTOR=1. It has no `report-uri` (no receiver on DMS hosts).
 * The full-page embeds (`/embed/dms-master`, `/embed/dms-record`) get the plain set without `report-uri`; with FP_DMS_API_ORIGINS their
 * connect-src lists the DMS API origins too.
 */
const env = deployEnv(process.env);
const sets = productionHeaderSets(process.env);
const lines = [nginxHeaders(sets.plain)];
lines.push('', '# location ^~ /embed/ (dms-master, dms-record: full-page launches, never framed, no report-uri):');
lines.push(nginxHeaders(sets.embedPage));
if (env.FP_EMBED_PARENTS) {
  lines.push('', `# location = /embed/dms-upload (the only framable route, by FP_EMBED_PARENTS; ${env.LEGACY ? 'M2 legacy build' : 'sandboxed'}; repeat every line, nginx does not inherit add_header):`);
  lines.push(nginxHeaders(sets.upload));
}
process.stdout.write(`${lines.join('\n')}\n`);
