import { compile, validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { FormDefinitionSchema, jsonPointer, type CompiledForm, type FormDefinition } from '@form/schema';
import { patternIssues } from '@form/validation';
import { distinctIssues, type PipelineIssue } from './issues.ts';
import { lookupIssues } from './lookups.ts';
import { redirectIssues } from './redirects.ts';
import { NO_ORG_PROFILE, resolveForPublish, type OrgProfileSource } from './resolve.ts';

/** What the pipeline needs to know besides the draft. Everything here comes from the database or the session, never from the draft. */
export interface PublishContext {
  /** The caller's active org (the one the transaction runs for). */
  orgId: string;
  /** The form's id as the route names it: the draft's own `formId` is client data and is overwritten with this. */
  formId: string;
  /** `form_access.redirect_allowlist`: null when no list was set, empty when no redirect is allowed. */
  redirectAllowlist: readonly string[] | null;
  /** Where the org's profile comes from; none by default (WP-T1.3 supplies one). */
  profiles?: OrgProfileSource | undefined;
  /**
   * The `definitionHash` of the plan the client compiled from this draft, when it sends one. A check, never an input:
   * the server compiles the definition itself, stores its own plan, and refuses (PLAN_MISMATCH) when the two differ.
   */
  clientDefinitionHash?: string | undefined;
  /**
   * The ids of the org's API credentials (`credentialIdsOf`), so a lookup, option list or check that names one that is not
   * the org's is refused (`credential_missing`). Omitted: that check is skipped (callers that have no database).
   */
  credentialIds?: ReadonlySet<string> | undefined;
}

export type PublishOutcome =
  | {
      ok: true;
      /** The definition to freeze: the draft, parsed strictly, with the route's form id, resolved against the org profile. */
      definition: FormDefinition;
      /** The server's own compilation of `definition`. The only plan that is ever stored. */
      compiled: CompiledForm;
      /** `compiled.definitionHash`: sha256 of the canonical JSON of `definition`. */
      contentHash: string;
      engine: string;
      variablesSnapshot: Record<string, unknown>;
      templateLineage: unknown[];
      /** Warnings only: an error would have made the outcome `blocked`. */
      issues: PipelineIssue[];
    }
  | { ok: false; reason: 'blocked'; issues: PipelineIssue[] }
  | { ok: false; reason: 'plan_mismatch'; serverHash: string; clientHash: string };

const blocked = (issues: readonly PipelineIssue[]): PublishOutcome => ({ ok: false, reason: 'blocked', issues: distinctIssues(issues) });
const hasError = (issues: readonly PipelineIssue[]) => issues.some((i) => i.severity === 'error');

/**
 * The publish pipeline (WP-1.07, architecture §3.2), the one road from a saved draft to a frozen version:
 *
 * 1. a strict parse of the draft as a v2 `FormDefinition` (unknown keys are refused, not dropped);
 * 2. `resolveForPublish`, which takes the org profile through `OrgProfileSource`;
 * 3. the publish checks: `validateDefinition(def, 'publish')` (structure, registry lints, the logic subset, cycles, page
 *    order), `patternIssues` (every author regex runs in RE2) and `redirectIssues` (the form's redirect allowlist);
 * 4. `compile`, then a comparison of its `definitionHash` with the client's, when the client sent one;
 * 5. the content hash, which is that same `definitionHash`.
 *
 * It reads nothing and writes nothing: the route decides what to store from the outcome. Any error issue blocks the
 * publish with the full list, so an author sees everything to fix at once.
 */
export async function publishPipeline(draft: unknown, ctx: PublishContext): Promise<PublishOutcome> {
  const parsed = FormDefinitionSchema.safeParse(draft);
  if (!parsed.success) {
    return blocked(
      parsed.error.issues.map((i) => ({
        severity: 'error' as const,
        code: 'invalid_definition' as const,
        path: jsonPointer(...i.path.map((p) => (typeof p === 'symbol' ? String(p) : p))),
        message: i.message,
      })),
    );
  }

  const profile = await (ctx.profiles ?? NO_ORG_PROFILE).load(ctx.orgId);
  const resolved = resolveForPublish({ ...parsed.data, formId: ctx.formId } as FormDefinition, profile);
  const { definition } = resolved;

  const checked: PipelineIssue[] = [
    ...validateDefinition(definition, 'publish', REGISTRY),
    ...patternIssues(definition),
    ...redirectIssues(definition, ctx.redirectAllowlist),
    ...lookupIssues(definition, ctx.credentialIds),
  ];
  if (hasError(checked)) return blocked(checked);

  // `compile` refuses what a draft may still hold but a version may not (a block this engine cannot run yet), and an
  // error here is a publish error however the checks above classified it.
  const result = compile(definition, REGISTRY);
  if (!result.ok) return blocked([...checked, ...result.issues]);
  const { compiled } = result;

  if (ctx.clientDefinitionHash !== undefined && ctx.clientDefinitionHash.toLowerCase() !== compiled.definitionHash) {
    return { ok: false, reason: 'plan_mismatch', serverHash: compiled.definitionHash, clientHash: ctx.clientDefinitionHash };
  }

  return {
    ok: true,
    definition,
    compiled,
    contentHash: compiled.definitionHash,
    engine: compiled.engine,
    variablesSnapshot: resolved.variablesSnapshot,
    templateLineage: resolved.templateLineage,
    issues: distinctIssues(checked),
  };
}
