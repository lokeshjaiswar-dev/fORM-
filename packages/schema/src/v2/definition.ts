import type { StoredBlock } from './blocks.ts';
import type { DataClassification, PrivacyConfig } from './compliance.ts';
import type { CaptchaConfig } from './config.ts';
import type { I18nBundle } from './i18n.ts';
import type { BlockId, BrandKitId, EndingId, Extensions, FormId, FormVersionId, IsoInstant, Locale, OrgId, PageId, ProductId, PurposeId, RuleId, Sha256Hex, TeamId, TemplateBindingId, TemplateId, TemplateVersionId, UserId, VariableId } from './ids.ts';
import type { ClientAction, LogicModel, Rule } from './logic.ts';
import type { Ending, Page, WelcomeScreen } from './pages.ts';
import type { RichDoc } from './rich-text.ts';
import type { BrandToken, TemplateVariableName } from './template-primitives.ts';
import type { TemplateKind } from './templates.ts';
import type { Behavior, Theme } from './theme.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §13  DEFINITION, DRAFT, VERSION, COMPILED PLAN, RUNTIME PROJECTION
 * ═════════════════════════════════════════════════════════════════════════ */

export const SCHEMA_VERSION = 2 as const;

/** Everything that decides what respondents see and how answers are judged. */
export interface FormDefinition {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Additive minor revision within v2 (optional-with-default fields only). */
  revision: number;
  formId: FormId;
  title: string;
  description?: RichDoc;
  welcome?: WelcomeScreen;
  blocks: Partial<Record<BlockId, StoredBlock>>;
  pages: Page[];                     // ≥ 1
  endings: Ending[];                 // ≥ 1
  defaultEndingId: EndingId;
  logic: LogicModel;
  privacy: PrivacyConfig;
  theme: Theme;
  behavior: Behavior;
  i18n: I18nBundle;
  x?: Extensions;
}

/** Template lineage summary on the form row (denormalised for the forms list). */
export interface TemplateOriginStamp { templateId: TemplateId; versionId: TemplateVersionId; name: string }

/** `forms` row (draft side). */
export interface FormRecord {
  id: FormId; orgId: OrgId; teamId?: TeamId; ownerUserId: UserId;
  draft: FormDefinition;
  draftRev: number;                  // CAS on PUT /forms/:id/draft (BLD-07/14)
  baseVersionId?: FormVersionId;     // BLD-08
  templateOrigin?: TemplateOriginStamp;
  brandKitId?: BrandKitId;           // null → team/org default kit
  lifecycle: 'active' | 'archived' | 'trashed';
  updatedAt: IsoInstant; updatedBy: UserId;
}

/** A runtime that lacks one refuses with "upgrade required" (mixed on-prem fleets). */
export type Capability =
  | 'schema@2' | 'logic@2' | 'expr@1' | 'rich_text@1'
  | 'payments' | 'appointments' | 'repeating_groups' | 'matrix' | 'cards_layout' | 'multi_locale'
  | 'save_and_resume' | 'email_otp' | 'consent_dpdp' | 'custom_css' | 'e2e_encryption' | `x-${string}`;

export interface ClientRuleStep { kind: 'rule'; ruleId: RuleId; scope: 'client+server'; row?: 'per_row' }
export interface ServerRuleStep { kind: 'rule'; ruleId: RuleId; scope: 'server'; row?: 'per_row' }
export type PlanStep =
  | { kind: 'default'; blockId: BlockId }      // dynamic defaults (today, template)
  | { kind: 'capture'; blockId: BlockId }      // hidden / context sources
  | { kind: 'variable'; varId: VariableId }
  | { kind: 'calc'; blockId: BlockId }
  /** onPath(p): computed from the jump cells of every earlier page; every value read depends on it. */
  | { kind: 'on_path'; pageId: PageId }
  | ClientRuleStep
  | ServerRuleStep;

/** Produced by compile() at publish, frozen in the version, recomputed and compared by the API. */
export interface CompiledForm {
  engine: 'logic@2';
  requires: Capability[];
  documentOrder: BlockId[];                          // DFS over pages → children
  parentOf: Partial<Record<BlockId, BlockId | PageId>>;
  pageOf: Partial<Record<BlockId, PageId>>;
  plan: PlanStep[];                                  // total evaluation order (§ semantics)
  reads: Partial<Record<string, string[]>>;          // step → cells read (incremental eval, trace)
  dataInventory: Array<{ purposeId: PurposeId; blockIds: BlockId[]; classifications: DataClassification[] }>;
  /** I13: effective classification and purposes of every derived cell (variables, calcs, set_value targets). */
  taint: Partial<Record<string, { classification: DataClassification; purposeIds: PurposeId[] }>>;
  definitionHash: Sha256Hex;
}

export interface TemplateLineageEntry {
  bindingId: TemplateBindingId; templateId: TemplateId; templateVersionId: TemplateVersionId;
  kind: TemplateKind; governance: 'bound' | 'detached';
}
/** Resolved template-variable and brand values at publish (audit: what the respondent saw). */
export interface VariablesSnapshot {
  variables: Partial<Record<TemplateVariableName, string | Partial<Record<Locale, string>>>>;
  brandKit?: { id: BrandKitId; tokensHash: Sha256Hex; tokens: Partial<Record<BrandToken, string>> };
  orgProfileUpdatedAt?: IsoInstant;
}

/** Immutable (PUB-01). `definition` is RESOLVED: no var nodes, no brand refs (I11). Stored at its original schemaVersion. */
export interface FormVersion {
  id: FormVersionId; orgId: OrgId; formId: FormId;
  number: number; label?: string;    // BLD-10
  schemaVersion: number;
  publishedAt: IsoInstant; publishedBy: UserId;
  definition: Readonly<FormDefinition>;
  compiled: CompiledForm;
  // Retirement is operational, not part of this immutable row: a version keeps accepting submissions for
  // FormOps.acceptPreviousVersionsHours (default 72) after a newer publish; then submit returns version_superseded.
  contentHash: Sha256Hex;            // sha256(JCS(definition)); cited by consent + signature audit
  templateLineage: TemplateLineageEntry[];
  variablesSnapshot: VariablesSnapshot;
}

/** Rules keep only client actions; rules left with no actions are dropped. */
export type PublicFormDefinition = Omit<FormDefinition, 'logic'> & {
  logic: Omit<LogicModel, 'rules'> & { rules: Array<Rule<ClientAction>> };
};

export type RuntimeStatus =
  | { state: 'open' }
  | { state: 'closed'; screen: RichDoc }
  | { state: 'not_yet_open'; opensAt: IsoInstant; screen: RichDoc }
  | { state: 'outside_hours'; nextOpenAt?: IsoInstant; screen: RichDoc }
  | { state: 'limit_reached'; screen: RichDoc }
  | { state: 'password'; screen: RichDoc }   // definition withheld until POST /f/:slug/unlock
  | { state: 'already_submitted'; screen: RichDoc };

/** GET /f/:slug after access checks. Snapshot-tested for leaks. */
export interface RuntimeFormVersion {
  versionId: FormVersionId; formId: FormId; contentHash: Sha256Hex;
  definition: PublicFormDefinition;  // notes, origin stamps, server actions stripped
  /** `reads` is kept (filtered to client steps) for incremental client evaluation (FND-13). */
  compiled: Omit<CompiledForm, 'dataInventory' | 'taint' | 'plan'> & { plan: Array<Exclude<PlanStep, ServerRuleStep>> };
  status: RuntimeStatus;
  accessToken?: string;              // short-lived, proves unlock/schedule checks
  publicConfig: {
    edition: 'saas' | 'onprem' | 'airgapped';
    captcha?: { provider: CaptchaConfig['provider']; siteKey?: string; powChallengeUrl?: string };
    payment?: { gateway: 'stripe' | 'razorpay'; publishableKey: string; testMode: boolean };
    upload: { presignUrl: string; maxFileBytes: number };
    soldOut?: ProductId[];
    branding: boolean;
    thirdPartyTrackingAllowed: boolean;
  };
}
