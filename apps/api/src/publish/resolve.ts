import type { FormDefinition } from '@form/schema';

/**
 * What an org tells every form it owns: the legal name, the privacy contact, the rights URL, the Board complaint text
 * (templates spec §5, WP-T1.3). A template's `var` nodes read these, and publish bakes them into the version so a
 * respondent's notice never changes under a form that is live. The profile itself, its table and its settings screen
 * arrive with WP-T1.3; until then nothing implements `OrgProfileSource` but `NO_ORG_PROFILE`.
 */
export interface OrgProfile {
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * Where publish gets the org's profile. An interface, not a table read, so WP-1.07 (publish) and WP-T1.3 (the profile)
 * do not wait for each other: T1.3 supplies a database-backed source and nothing in `pipeline.ts` changes.
 */
export interface OrgProfileSource {
  /** The org's profile, or null when it has none (or none is kept yet). Must answer for `orgId` only. */
  load(orgId: string): Promise<OrgProfile | null>;
}

/** The default source: no org has a profile, so nothing is resolved. */
export const NO_ORG_PROFILE: OrgProfileSource = { load: () => Promise.resolve(null) };

/** What `resolveForPublish` hands the pipeline: the definition to check, compile and store, and what it was resolved from. */
export interface ResolvedForPublish {
  definition: FormDefinition;
  /** The org-profile values baked into the definition (`form_versions.variables_snapshot`). */
  variablesSnapshot: Record<string, unknown>;
  /** Where the form came from (`form_versions.template_lineage`). */
  templateLineage: unknown[];
}

/**
 * Step 2 of the pipeline (architecture §3.2): turn the draft into the definition that is frozen. With no profile
 * nothing is resolved and the definition passes through as it is, with an empty snapshot and lineage. WP-T1.3 makes the
 * non-null case replace `var` nodes with the profile's values and record them in `variablesSnapshot`; WP-T1.3 also owns
 * `template_variable_unresolved`. Until then a profile that is returned is not read, so a draft that still holds `var`
 * nodes publishes with them, exactly as it does today.
 */
export function resolveForPublish(definition: FormDefinition, _profile: OrgProfile | null): ResolvedForPublish {
  return { definition, variablesSnapshot: {}, templateLineage: [] };
}
