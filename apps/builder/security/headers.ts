/**
 * Builder response headers (architecture §4.5, FND-20). One source for the Vite dev and preview servers and for the
 * production static server: `pnpm --filter @form/builder headers:nginx` prints them as nginx `add_header` lines
 * (docs/platform/builder-security-headers.md).
 */

/** Where the Vite dev and preview servers collect violation reports (security/vite.ts). */
export const DEV_CSP_REPORT_PATH = '/__csp-report';
/** The API endpoint that receives them in production (apps/api `POST /v1/csp-reports`). */
export const API_CSP_REPORT_PATH = '/v1/csp-reports';
export const CSP_REPORT_GROUP = 'csp';

export interface BuilderHeaderOptions {
  /**
   * `production` is the enforced policy (vite preview, the static server). `development` is for Vite's dev server,
   * whose React Refresh preamble is an inline script and whose CSS arrives in `<style>` elements; Trusted Types is
   * report-only there so a Vite error overlay still shows.
   */
  mode: 'production' | 'development';
  /** Origins the SPA calls besides its own (the API when it is not same-origin), e.g. `https://api.form.example`. */
  connectOrigins?: readonly string[];
  /** Absolute or same-origin URL that receives violation reports (`report-uri` and the `csp` Reporting-Endpoints entry). */
  reportUri?: string;
  /**
   * Also name the Reporting API endpoint (`report-to`, `Reporting-Endpoints`); default true. Chromium then uses only
   * the Reporting API, which delivers in the background with no deadline, so the Vite servers (and the e2e suite) keep
   * to `report-uri`, which Chromium sends at once.
   */
  reportTo?: boolean;
  /**
   * Set only for the `/embed/*` pages (embedHeaders): the origins that may frame them besides the page's own, as
   * `frame-ancestors 'self' <origins>`. `X-Frame-Options` is then left out, since it cannot name an origin list and
   * would override the CSP in browsers that honour both. Every other route keeps `'none'` and `DENY`.
   */
  frameAncestors?: readonly string[];
}

type Directives = Array<[string, ...string[]]>;

const serialize = (directives: Directives) => directives.map((d) => d.join(' ')).join('; ');

function origins(list: readonly string[]): string[] {
  return [...new Set(list.map((o) => new URL(o).origin))];
}

function reporting({ reportUri, reportTo = true }: BuilderHeaderOptions): Directives {
  if (!reportUri) return [];
  return reportTo ? [['report-uri', reportUri], ['report-to', CSP_REPORT_GROUP]] : [['report-uri', reportUri]];
}

/** The Trusted Types pair. No policy may be created (`trusted-types 'none'`): the builder has no HTML sink. */
const TRUSTED_TYPES: Directives = [['require-trusted-types-for', "'script'"], ['trusted-types', "'none'"]];

/** The enforced policy. */
export function builderCsp(options: BuilderHeaderOptions): string {
  const dev = options.mode === 'development';
  const directives: Directives = [
    ['default-src', "'self'"],
    ['script-src', "'self'", ...(dev ? ["'unsafe-inline'"] : [])],
    ['style-src', "'self'", ...(dev ? ["'unsafe-inline'"] : [])],
    ['img-src', "'self'", 'data:', 'blob:'],
    ['font-src', "'self'"],
    ['connect-src', "'self'", ...origins(options.connectOrigins ?? [])],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
    options.frameAncestors === undefined ? ['frame-ancestors', "'none'"] : ['frame-ancestors', "'self'", ...origins(options.frameAncestors)],
    ...(dev ? [] : TRUSTED_TYPES),
    ...reporting(options),
  ];
  return serialize(directives);
}

export function builderSecurityHeaders(options: BuilderHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': builderCsp(options),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    /* Browsers without `frame-ancestors`. */
    ...(options.frameAncestors === undefined ? { 'X-Frame-Options': 'DENY' } : {}),
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (options.mode === 'development') headers['Content-Security-Policy-Report-Only'] = serialize([...TRUSTED_TYPES, ...reporting(options)]);
  if (options.reportUri && options.reportTo !== false) headers['Reporting-Endpoints'] = `${CSP_REPORT_GROUP}="${options.reportUri}"`;
  return headers;
}

/** The `/embed/*` pages (fORM- hosted inside DMS+): the same headers, but framable by `parents` (and the page's own origin). */
export function embedHeaders(options: BuilderHeaderOptions, parents: readonly string[]): Record<string, string> {
  return builderSecurityHeaders({ ...options, frameAncestors: parents });
}

const originList = (raw: string | undefined): string[] => (raw ?? '').split(',').map((o) => o.trim()).filter(Boolean);

/**
 * The production headers from the deployment's settings (architecture §1.5): `PUBLIC_API_URL` when the API has its own
 * origin (SaaS: `https://api.form.example`); unset, the API is served from the builder's origin under `/v1`.
 */
export function productionHeaders(env: { PUBLIC_API_URL?: string | undefined; FP_DMS_API_ORIGINS?: string | undefined }): Record<string, string> {
  const api = env.PUBLIC_API_URL ? new URL(env.PUBLIC_API_URL).origin : undefined;
  const dms = originList(env.FP_DMS_API_ORIGINS).map((o) => new URL(o).origin);
  return builderSecurityHeaders({
    mode: 'production',
    connectOrigins: [...(api ? [api] : []), ...dms],
    reportUri: `${api ?? ''}${API_CSP_REPORT_PATH}`,
  });
}

/**
 * The production headers of the framable embed route(s): `FP_EMBED_PARENTS` (comma separated origins) may frame them.
 * `connect-src` also lists `FP_DMS_API_ORIGINS` (the DMS API origins the embed pages call; the dev and preview
 * servers do the same from `VITE_FP_DMS_API_ORIGINS`).
 */
export function productionEmbedHeaders(env: {
  PUBLIC_API_URL?: string | undefined;
  FP_EMBED_PARENTS?: string | undefined;
  FP_DMS_API_ORIGINS?: string | undefined;
}): Record<string, string> {
  const api = env.PUBLIC_API_URL ? new URL(env.PUBLIC_API_URL).origin : undefined;
  const dms = originList(env.FP_DMS_API_ORIGINS).map((o) => new URL(o).origin);
  return embedHeaders(
    { mode: 'production', connectOrigins: [...(api ? [api] : []), ...dms], reportUri: `${api ?? ''}${API_CSP_REPORT_PATH}` },
    originList(env.FP_EMBED_PARENTS),
  );
}

/** The embed routes that run inside a frame. Every other `/embed/*` route (`dms-master`) is a top-level page and stays unframable. */
export const FRAMABLE_EMBED_ROUTES: readonly string[] = ['dms-upload'];

/** True for `<base>embed/<framable route>` exactly (a trailing slash is fine, a sub-path is not). Nothing else is framable. */
export function isFramablePath(url: string | undefined, base = '/'): boolean {
  const path = (url ?? '').split(/[?#]/)[0] ?? '';
  return FRAMABLE_EMBED_ROUTES.some((route) => {
    const prefix = `${base.replace(/\/+$/, '')}/embed/${route}`;
    return path === prefix || path === `${prefix}/`;
  });
}

/** True for `<base>embed` and `<base>embed/...` (`base` is the app's base path, VITE_BASE: `/` or `/formplus/`). Nothing else is framable. */
export function isEmbedPath(url: string | undefined, base = '/'): boolean {
  const prefix = `${base.replace(/\/+$/, '')}/embed`;
  const path = (url ?? '').split(/[?#]/)[0] ?? '';
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** nginx `add_header … always;` lines for the static builder. */
export function nginxHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `add_header ${name} "${value.replaceAll('"', '\\"')}" always;`)
    .join('\n');
}
