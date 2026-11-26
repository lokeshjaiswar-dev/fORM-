import { z } from 'zod';

/*
 * Runs before any other module of the upload entry (it is the entry's first import). The page's CSP has no 'unsafe-eval' and
 * enforces Trusted Types: zod's JIT compiles parsers with `new Function`, and its probe for that alone is a violation. Jitless
 * parsing is the same parsing without generated code. (Same as src/csp.ts, which belongs to the SPA entry and is not imported here.)
 */
z.config({ jitless: true });
