import { deployEnv, nginxHeaders, productionEmbedHeaders, productionHeaders } from './headers.ts';

/*
 * `pnpm --filter @form/builder headers:nginx`: the production builder headers for this deployment's PUBLIC_API_URL.
 * The VITE_* build names (VITE_API_URL, VITE_FP_DMS_API_ORIGINS, VITE_FP_DMS_API_BASE, VITE_FP_EMBED_PARENTS) work as well as the FP_* ones.
 * With FP_EMBED_PARENTS (comma separated origins that may frame `/embed/*`, e.g. the DMS+ origin) it also prints the
 * lines for the `/embed/dms-upload` location (FP_DMS_API_ORIGINS adds the DMS API origins to its connect-src).
 * Every other `/embed/*` route, `dms-master` included, uses the plain headers above (no framing); with FP_DMS_API_ORIGINS
 * their connect-src lists the DMS API origins too.
 */
const env = deployEnv(process.env);
const lines = [nginxHeaders(productionHeaders(env))];
if (env.FP_EMBED_PARENTS) {
  lines.push('', '# location = /embed/dms-upload (the only framable route, by FP_EMBED_PARENTS; repeat every line, nginx does not inherit add_header):');
  lines.push(nginxHeaders(productionEmbedHeaders(env)));
}
process.stdout.write(`${lines.join('\n')}\n`);
