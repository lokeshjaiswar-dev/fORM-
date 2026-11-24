import { nginxHeaders, productionEmbedHeaders, productionHeaders } from './headers.ts';

/*
 * `pnpm --filter @form/builder headers:nginx`: the production builder headers for this deployment's PUBLIC_API_URL.
 * With FP_EMBED_PARENTS (comma separated origins that may frame `/embed/*`, e.g. the DMS+ origin) it also prints the
 * lines for the `/embed/` location.
 */
const lines = [nginxHeaders(productionHeaders({ PUBLIC_API_URL: process.env.PUBLIC_API_URL }))];
if (process.env.FP_EMBED_PARENTS) {
  lines.push('', '# location ^~ /embed/ (framable by FP_EMBED_PARENTS; repeat every line, nginx does not inherit add_header):');
  lines.push(nginxHeaders(productionEmbedHeaders({ PUBLIC_API_URL: process.env.PUBLIC_API_URL, FP_EMBED_PARENTS: process.env.FP_EMBED_PARENTS })));
}
process.stdout.write(`${lines.join('\n')}\n`);
