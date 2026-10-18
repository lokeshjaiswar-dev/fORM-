import type { Answers } from './answers.ts';
import type { FieldRegistry, PublishIssue } from './blocks.ts';
import type { CompiledForm, FormDefinition, FormVersion, PlanStep, RuntimeFormVersion, RuntimeStatus, VariablesSnapshot } from './definition.ts';
import type { ScalarValue } from './expr.ts';
import type { BlockId, EndingId, HolidayCalendarId, IsoDate, IsoInstant, Locale, OptionId, PageId, RuleId, Sha256Hex, TimeZone, VariableId } from './ids.ts';
import type { ServerAction } from './logic.ts';
import type { AnyFormDocument, MigrationContext, MigrationNote } from './migration.ts';
import type { FormOps } from './ops.ts';
import type { BrandKit, FormTemplateBinding, FormTemplatePayload, InsertSnippetResult, InstantiateContext, InstantiateResult, LockSpec, OrgProfile, TemplateDiff, TemplateVersion, TemplateWarning } from './templates.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §19  PACKAGE ENTRY POINTS (pure unless noted)
 *      Signatures only, as function types (ADR-0002 §1); implemented in logic, validation, templates-core and schema/migrate.
 * ═════════════════════════════════════════════════════════════════════════ */

export interface EvalMeta {
    /**
   * Frozen per evaluation. Client: frozen at the session's startedAt (reset on resume), so client and server
   * agree. Server re-simulation uses clamp(client.startedAt, receivedAt−24h, receivedAt); access checks use receivedAt.
   */
  now: IsoInstant;
  timeZone: TimeZone;                // form tz
  locale: Locale;
  urlParams: Readonly<Record<string, string>>;
  device?: 'desktop' | 'tablet' | 'mobile';
  pageUrl?: string; referrer?: string; embedOrigin?: string;
  isPreview: boolean;
  holidayCalendars?: Readonly<Partial<Record<HolidayCalendarId, IsoDate[]>>>;
  shuffleSeed: string;               // per session
}

export interface EvalState {
  visible: ReadonlySet<BlockId | PageId>;
  required: ReadonlySet<BlockId>;
  disabled: ReadonlySet<BlockId>;
  hiddenOptions: Readonly<Partial<Record<BlockId, OptionId[]>>>;
  /** Answers after defaults/captures/set_value/calculations, with invisible, disabled and off-path answers removed. */
  values: Answers;
  variables: Readonly<Partial<Record<VariableId, ScalarValue>>>;
  submitBlocks: Array<{ ruleId: RuleId; message: string; atPage?: PageId; anchorBlockId?: BlockId }>;
  nextPage(from: PageId): PageId | { end: EndingId };
  path: PageId[];
  endingId: EndingId;
  serverEffects: Array<ServerAction & { ruleId: RuleId }>;     // server scope only
  trace?: Array<{ step: PlanStep; fired: boolean | null; diagnostics?: string[] }>; // LOG-22
}

export type ValidateDefinition = (def: FormDefinition, mode: 'save' | 'publish', registry: FieldRegistry) => PublishIssue[];
export type Compile = (def: FormDefinition, registry: FieldRegistry) => { ok: true; compiled: CompiledForm } | { ok: false; issues: PublishIssue[] };
/** Publish: resolve live vars + brand refs, bump consent noticeVersion, compile, hash. */
export type ResolveForPublish = (draft: FormDefinition, ctx: { orgProfile: OrgProfile; brandKit: BrandKit | null; previous?: FormVersion }) => { definition: FormDefinition; snapshot: VariablesSnapshot; issues: PublishIssue[] };
export type Evaluate = (version: FormVersion | RuntimeFormVersion, answers: Answers, meta: EvalMeta, scope: 'client' | 'server', opts?: { trace?: boolean }) => EvalState;
export type ProjectForRuntime = (version: FormVersion, status: RuntimeStatus, publicConfig: RuntimeFormVersion['publicConfig']) => RuntimeFormVersion;
export type Migrate = (doc: AnyFormDocument, ctx: MigrationContext) => { definition: FormDefinition; notes: MigrationNote[] };
export type Instantiate = (version: TemplateVersion, ctx: InstantiateContext) => InstantiateResult;
export type InsertSnippet = (version: TemplateVersion, form: FormDefinition, at: { pageId: PageId; afterBlockId?: BlockId }, ctx: Omit<InstantiateContext, 'newFormId' | 'include'>) => InsertSnippetResult;
export type LockFingerprint = (doc: FormDefinition, binding: FormTemplateBinding, lock: LockSpec) => Sha256Hex;
export type SanitizeForTemplate = (def: FormDefinition, ops: FormOps | undefined, orgProfile: OrgProfile) => { payload: FormTemplatePayload; piiHits: Array<{ path: string; kind: 'email' | 'phone_in' | 'pan' | 'aadhaar' | 'gstin' }>; warnings: TemplateWarning[] };
export type DiffTemplate = (base: TemplateVersion, theirs: TemplateVersion, ours: FormDefinition, binding: FormTemplateBinding) => TemplateDiff;
