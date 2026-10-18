/**
 * packages/schema/src/v2 — fORM- FORM SCHEMA v2 (v2.1: synthesised, then revised after the
 * compliance and feasibility reviews; see docs/platform/05-review-log.md)
 *
 * One contract for apps/builder, apps/runtime, apps/api, apps/worker and
 * packages/{registry,logic,validation,renderer,sdk,templates-core}. Package scope: @form/*. Pure types; every exported
 * type has a zod twin in ./zod with a `z.infer<> === T` assertion test.
 *
 * Invariants (validateDefinition(def, 'save' | 'publish')):
 *  I1  Ids are opaque, generated once, never derived from text, never reused.
 *      BlockId, PageId and EndingId share ONE namespace per definition.
 *  I2  The answer SHAPE of a block is a function of block.type only (AnswerValueMap).
 *  I3  FieldKey is unique per form (repeating-group children and logic variables included).
 *  I4  Every reference is by id; dangling ids are draft warnings and publish errors.
 *  I5  No HTML anywhere. Rich text is a TipTap/ProseMirror-compatible JSON subset.
 *  I6  No external media URLs (AssetRef only). Links are scheme-allowlisted.
 *  I7  Every value-carrying block has `compliance` (classification + purposes).
 *  I8  Visibility / required / enabled / option-visibility / page jumps / validation bounds
 *      (e.g. DateBound {kind:'field'}) may read only blocks on the SAME or EARLIER pages, and
 *      this holds TRANSITIVELY through every cell they read (page-order rule). Calculations,
 *      variables, endings and server actions may read anything.
 *  I9  Unanswered === key absent. Never '' / null / [] in Answers.
 *  I10 Logic evaluation is a pure, total function of (version, answers, meta).
 *  I11 A published FormVersion contains no `var` nodes, no brand refs, no secrets and no
 *      live operational state; the runtime projection also drops server-only actions,
 *      builder notes and template origin stamps.
 *  I12 Array order is canonical (pages, children, options, rules). There is no `order` field.
 *  I13 Taint: a calculation, variable, set_value target or pipe inherits the highest
 *      classification and the union of purposes of every cell it reads; lowering it needs an
 *      explicit `declassify` with a reason (audited).
 *  I14 In a form with a 'dpdp' consent block, that block is on a page before (or the same page
 *      as, and above) the first block whose purposes are consent-based.
 */

export * from './ids.ts';
export * from './template-primitives.ts';
export * from './rich-text.ts';
export * from './compliance.ts';
export * from './catalogue.ts';
export * from './envelope.ts';
export * from './config.ts';
export * from './blocks.ts';
export * from './pages.ts';
export * from './logic.ts';
export * from './expr.ts';
export * from './theme.ts';
export * from './i18n.ts';
export * from './definition.ts';
export * from './ops.ts';
export * from './answers.ts';
export * from './submissions.ts';
export * from './templates.ts';
export * from './migration.ts';
export * from './entry-points.ts';
