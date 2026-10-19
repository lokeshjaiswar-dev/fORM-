import { z } from 'zod';

/*
 * Runs before any other builder module. The builder's CSP has no 'unsafe-eval' and enforces Trusted Types (FND-20):
 * zod's JIT compiles parsers with `new Function`, and its probe for that alone is a violation. Jitless parsing is the
 * same parsing without generated code.
 */
z.config({ jitless: true });
