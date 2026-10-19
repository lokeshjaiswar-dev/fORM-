import type * as V1 from '../v1.ts';
import type { FormDefinition } from '../v2/definition.ts';

/** A stored form of any schema version (schema §18). The v1 shape is named only in `src/migrate` and the v1 reader. */
export type AnyFormDocument = V1.FormSchema | FormDefinition;
