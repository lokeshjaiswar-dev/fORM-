import { nginxHeaders, productionHeaders } from './headers.ts';

/* `pnpm --filter @form/builder headers:nginx`: the production builder headers for this deployment's PUBLIC_API_URL. */
process.stdout.write(`${nginxHeaders(productionHeaders({ PUBLIC_API_URL: process.env.PUBLIC_API_URL }))}\n`);
