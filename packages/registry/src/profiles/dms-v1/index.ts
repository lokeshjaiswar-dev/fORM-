/*
 * Contract stub (T-FORM-1, first commit). Types and signatures are final; bodies land in the next commits.
 * T-FORM-2 imports `elementsToDefinition` from here.
 */
import type { AnswerValueMap, FieldBlock, FormDefinition } from '@form/schema';
import type { DmsElement, DmsTranslateOptions, ProfileIssue } from './types.ts';

export { DMS_V1_TYPES, isDmsV1Type } from './types.ts';
export type { DmsElement, DmsOption, DmsTranslateOptions, DmsV1Type, ProfileIssue } from './types.ts';

export function elementsToDefinition(_elements: readonly DmsElement[], _options: DmsTranslateOptions): FormDefinition {
  throw new Error('elementsToDefinition: not implemented yet');
}

export function definitionToElements(_def: FormDefinition): DmsElement[] {
  throw new Error('definitionToElements: not implemented yet');
}

export function checkDmsV1(_def: FormDefinition): ProfileIssue[] {
  throw new Error('checkDmsV1: not implemented yet');
}

/** A DMS string (`DD-MM-YYYY` date, digits, option value...) as the block's answer; `undefined` when empty or not representable. */
export function dmsToAnswer(_block: FieldBlock, _raw: string): AnswerValueMap[FieldBlock['type']] | undefined {
  throw new Error('dmsToAnswer: not implemented yet');
}

/** The block's answer as the DMS string the upload journey and the record API carry. */
export function answerToDms(_block: FieldBlock, _answer: AnswerValueMap[FieldBlock['type']] | undefined): string {
  throw new Error('answerToDms: not implemented yet');
}

export const DMS_V1_TILES: readonly never[] = [];
