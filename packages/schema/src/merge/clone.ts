/**
 * Deep copy of JSON data. `structuredClone` is a host global (it is not in the ES2023 lib that the pure packages
 * typecheck against, and @form/schema is compiled as source into @form/logic, @form/validation and
 * @form/templates-core), so copy through JSON like migrate/v1-to-v2.ts does. Definitions are JSON by contract.
 */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
