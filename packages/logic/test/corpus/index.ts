/*
 * The logic test corpus as one entry point, published to other packages' tests as the test-only subpath
 * `@form/logic/test-corpus` (package.json `exports`, as `@form/schema/migration-fixtures` does for the v1 documents).
 * It holds the determinism corpus (35 v1 parity forms, random P0 forms, text and decimal edge cases), the seeded
 * generators behind it, the v1 oracle's form model and the small definition/answer builders the corpus is written with.
 * Unit tests only: nothing in a production bundle may import it.
 *
 * The first outside user is the API's client/server parity test (WP-1.12, apps/api/src/validate-submission.parity.test.ts),
 * which replays the same forms and answers through the renderer's evaluation and the server's `checkAnswers`.
 */
export * from '../build.ts';
export * from './determinism.ts';
export * from './generate.ts';
export * from './random.ts';
export * from './v1.ts';
