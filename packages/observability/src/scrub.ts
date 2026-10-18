/**
 * URL scrubbing for logs and traces (architecture §3.2, C-M13): query strings keep only `lang` and `embed`
 * (with short, plain values) and the names of `utm_*` parameters; everything else, including prefill values,
 * is dropped. Path segments that carry secrets (signed links, invite and resume tokens) are replaced.
 */
const KEEP_VALUE = new Set(['lang', 'embed']);
const SAFE_VALUE = /^[A-Za-z0-9_-]{1,35}$/;
const NAME_ONLY = /^utm_[a-z0-9_]{1,32}$/i;

const SECRET_PATHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/s\/[^/]+/, '/s/:token'],
  [/^\/v1\/invites\/[^/]+/, '/v1/invites/:token'],
  [/^(\/f\/[^/]+\/drafts\/)[^/]+/, '$1:resumeToken'],
];

const ORIGIN = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/?#]*@)?([^/?#]*)/i;

function decode(s: string): string | undefined {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
}

export function scrubQuery(query: string): string {
  const out: string[] = [];
  for (const part of query.replace(/^\?/, '').split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const name = decode(eq === -1 ? part : part.slice(0, eq));
    if (name === undefined) continue;
    if (KEEP_VALUE.has(name)) {
      const value = eq === -1 ? '' : decode(part.slice(eq + 1));
      out.push(value !== undefined && SAFE_VALUE.test(value) ? `${name}=${value}` : name);
    } else if (NAME_ONLY.test(name)) {
      out.push(name);
    }
  }
  return out.join('&');
}

export function scrubPath(path: string): string {
  let p = path;
  for (const [re, replacement] of SECRET_PATHS) p = p.replace(re, replacement);
  return p;
}

/** Scrubs a request target (`/path?query`) or an absolute URL; drops credentials and fragments. */
export function scrubUrl(url: string): string {
  const hash = url.indexOf('#');
  const noHash = hash === -1 ? url : url.slice(0, hash);
  const m = ORIGIN.exec(noHash);
  const origin = m ? `${m[1]}${m[2]}` : '';
  const rest = m ? noHash.slice(m[0].length) : noHash;
  const q = rest.indexOf('?');
  const path = scrubPath(q === -1 ? rest : rest.slice(0, q));
  const query = q === -1 ? '' : scrubQuery(rest.slice(q + 1));
  return `${origin}${path}${query ? `?${query}` : ''}`;
}
