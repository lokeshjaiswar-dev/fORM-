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

/**
 * The `/embed/*` pages (fORM- hosted inside DMS+): the same headers, but framable by `parents` (and the page's own origin), and
 * with no `report-uri`, `report-to` or `Reporting-Endpoints`: the DMS hosts have no receiver for them (DESIGN BD-09, FACTS A22).
 */
export function embedHeaders(options: BuilderHeaderOptions, parents: readonly string[]): Record<string, string> {
  const { reportUri: _reportUri, reportTo: _reportTo, ...quiet } = options;
  return builderSecurityHeaders({ ...quiet, frameAncestors: parents });
}

/** The inputs of the sandboxed upload header set. */
export interface SandboxedEmbedOptions {
  /** `VITE_FP_EMBED_PARENTS`: the origins that may frame the page (`frame-ancestors 'self' <parents>`). */
  parents: readonly string[];
  /**
   * `FP_PUBLIC_ORIGINS`: this deployment's own public origin(s), listed explicitly beside `'self'` in `script-src`, `style-src`,
   * `font-src` and `img-src`. Inside an opaque-origin document (the sandbox) `'self'` is not matched the same way by every engine
   * (SEC-DESIGN 3.3 B3). Default: the parents (the DMS app host serves fORM- under `/formplus`).
   */
  publicOrigins?: readonly string[];
}

/**
 * The response headers of `/formplus/embed/dms-upload` (SEC-DESIGN 3.3, set `sandboxedEmbed`). The document gets an opaque origin
 * from the `sandbox` directive even when it is opened top-level, so `document.cookie`, web storage and IndexedDB throw and every
 * request to the DMS host is cross-origin with `Origin: null`. No network (`connect-src 'none'`), nothing can be posted
 * (`form-action 'none'`), no report endpoint (no receiver on DMS hosts), nothing cached, no referrer.
 */
export function sandboxedEmbedCsp(options: SandboxedEmbedOptions): string {
  const listed = options.publicOrigins !== undefined && options.publicOrigins.length > 0 ? options.publicOrigins : options.parents;
  const explicit = origins(listed);
  const directives: Directives = [
    ['sandbox', 'allow-scripts', 'allow-forms'],
    ['default-src', "'none'"],
    ['script-src', "'self'", ...explicit],
    ['style-src', "'self'", ...explicit],
    ['img-src', "'self'", ...explicit, 'data:', 'blob:'],
    ['font-src', "'self'", ...explicit],
    ['connect-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'none'"],
    ['frame-ancestors', "'self'", ...origins(options.parents)],
    ...TRUSTED_TYPES,
  ];
  return serialize(directives);
}

export function sandboxedEmbedHeaders(options: SandboxedEmbedOptions): Record<string, string> {
  return {
    'Content-Security-Policy': sandboxedEmbedCsp(options),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
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
 * The production headers of the framable embed route when the build is the M2 LEGACY one (`VITE_FP_LEGACY_DESCRIPTOR=1`): today's
 * set (`frame-ancestors 'self' <FP_EMBED_PARENTS>`, the same-origin `/1` host needs it) without `report-uri`, and `no-store`.
 * `connect-src` also lists `FP_DMS_API_ORIGINS` (the DMS API origins the embed pages call; the dev and preview servers do the same
 * from `VITE_FP_DMS_API_ORIGINS`).
 */
export function productionEmbedHeaders(env: {
  PUBLIC_API_URL?: string | undefined;
  FP_EMBED_PARENTS?: string | undefined;
  FP_DMS_API_ORIGINS?: string | undefined;
}): Record<string, string> {
  const api = env.PUBLIC_API_URL ? new URL(env.PUBLIC_API_URL).origin : undefined;
  const dms = originList(env.FP_DMS_API_ORIGINS).map((o) => new URL(o).origin);
  return embedHeaders({ mode: 'production', connectOrigins: [...(api ? [api] : []), ...dms] }, originList(env.FP_EMBED_PARENTS));
}

/** The full-page embeds (`/embed/dms-master`, `/embed/dms-record`): the plain set (never framed, X-Frame-Options DENY) without `report-uri`. */
export function productionEmbedPageHeaders(env: { PUBLIC_API_URL?: string | undefined; FP_DMS_API_ORIGINS?: string | undefined }): Record<string, string> {
  const api = env.PUBLIC_API_URL ? new URL(env.PUBLIC_API_URL).origin : undefined;
  const dms = originList(env.FP_DMS_API_ORIGINS).map((o) => new URL(o).origin);
  return builderSecurityHeaders({ mode: 'production', connectOrigins: [...(api ? [api] : []), ...dms] });
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The settings of one deployment as the build sees them: the `VITE_*` names a Docker build passes (the same ones the
 * Vite servers read) and the `FP_*` / `PUBLIC_API_URL` names `headers:nginx` has always taken (they win when both are set).
 * `VITE_FP_DMS_API_BASE` adds the origin of each absolute entry to the DMS origins, as the Vite config does.
 * `FP_PUBLIC_ORIGINS` (this deployment's public origin(s)) defaults to the embed parents; `LEGACY` is `VITE_FP_LEGACY_DESCRIPTOR=1`.
 */
export function deployEnv(env: Env): {
  PUBLIC_API_URL: string | undefined;
  FP_DMS_API_ORIGINS: string | undefined;
  FP_EMBED_PARENTS: string | undefined;
  FP_PUBLIC_ORIGINS: string | undefined;
  LEGACY: boolean;
} {
  const bases = originList(env.VITE_FP_DMS_API_BASE).filter((b) => /^https?:/i.test(b)).map((b) => new URL(b).origin);
  const dms = [...originList(env.FP_DMS_API_ORIGINS ?? env.VITE_FP_DMS_API_ORIGINS), ...bases];
  const parents = env.FP_EMBED_PARENTS ?? env.VITE_FP_EMBED_PARENTS;
  const publicOrigins = env.FP_PUBLIC_ORIGINS || env.VITE_FP_PUBLIC_ORIGINS || parents;
  return {
    PUBLIC_API_URL: env.PUBLIC_API_URL || env.VITE_API_URL || undefined,
    FP_DMS_API_ORIGINS: dms.length > 0 ? dms.join(',') : undefined,
    FP_EMBED_PARENTS: parents,
    FP_PUBLIC_ORIGINS: publicOrigins,
    LEGACY: (env.VITE_FP_LEGACY_DESCRIPTOR ?? env.FP_LEGACY_DESCRIPTOR) === '1',
  };
}

/**
 * The production header sets of one build. `plain`: every route (frame-ancestors 'none'). `embedPage`: `/embed/dms-master|dms-record`
 * (plain, no report-uri). `upload`: the framable `/embed/dms-upload`: `sandboxedEmbed` (SEC-DESIGN 3.3) in the default build, today's
 * framable set in the M2 legacy build. `embed` is that legacy framable set whatever the build (kept for `headers:nginx`).
 */
export function productionHeaderSets(env: Env): { plain: Record<string, string>; embedPage: Record<string, string>; embed: Record<string, string>; upload: Record<string, string> } {
  const e = deployEnv(env);
  const embed = { ...productionEmbedHeaders(e), 'Cache-Control': 'no-store' };
  const upload = e.LEGACY ? embed : sandboxedEmbedHeaders({ parents: originList(e.FP_EMBED_PARENTS), publicOrigins: originList(e.FP_PUBLIC_ORIGINS) });
  return { plain: productionHeaders(e), embedPage: productionEmbedPageHeaders(e), embed, upload };
}

/** The production headers a path gets: the upload set for the framable route, the embed-page set for `/embed/*`, the plain set for everything else. */
export function productionHeadersForPath(url: string | undefined, env: Env, base = '/'): Record<string, string> {
  const sets = productionHeaderSets(env);
  if (isFramablePath(url, base)) return sets.upload;
  return isEmbedPath(url, base) ? sets.embedPage : sets.plain;
}

/** The embed routes that run inside a frame. Every other `/embed/*` route (`dms-master`, `dms-record`) is a top-level page and stays unframable. */
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
