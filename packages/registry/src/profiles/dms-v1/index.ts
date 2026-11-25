/*
 * Profile `dms-v1` (T-FORM-1): the seven field types DMS+ supports, their DMS dialect, the guard that keeps a definition
 * inside them, and the answer codecs for DMS strings. Import through `@form/registry/profiles/dms-v1`.
 */
export { DMS_V1_TYPES, isDmsV1Type } from './types.ts';
export type { DmsElement, DmsOption, DmsTranslateOptions, DmsV1Type, ProfileIssue } from './types.ts';
export { elementsToDefinition, definitionToElements } from './translate.ts';
export { checkDmsV1 } from './guard.ts';
export { dmsToAnswer, answerToDms, parseDmsDate, parseDmsPhone, phoneToDms, dmsPhoneProblem } from './answers.ts';
export { DMS_V1_TILES } from './tiles.ts';
export type { DmsV1Tile } from './tiles.ts';
export { blankDmsDefinition } from './blank.ts';
export { fnv1a64hex, optionIdOf } from './fnv.ts';
export { dmsTypeOf, TEXT_PATTERNS } from './shared.ts';
export { LEGACY_KEY, legacyOfElement, legacyOfBlock, isLegacyReadOnly } from './legacy.ts';
export type { DmsLegacyMarker } from './legacy.ts';
