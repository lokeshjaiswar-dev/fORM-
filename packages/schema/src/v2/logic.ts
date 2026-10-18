import type { _ExactKeys } from './_internal.ts';
import type { Expr, ExprType } from './expr.ts';
import type { BlockId, ConditionId, CurrencyCode, DecimalString, EmailAddress, EndingId, FieldKey, IntegrationId, IsoDate, IsoLocalDateTime, IsoTime, MinorUnits, NotificationId, NotificationVariantId, OptionId, PageId, PdfTemplateId, RuleGroupId, RuleId, TimeZone, UserId, VariableId, WebhookId, WorkflowId } from './ids.ts';
import type { AnswerPath, ValueFormat, ValueRef } from './rich-text.ts';
import type { Origin } from './template-primitives.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §9  LOGIC (LOG-*) — evaluated by packages/logic in browser, API and worker
 * ═════════════════════════════════════════════════════════════════════════ */

export type Literal =
  | { type: 'text'; value: string }
  | { type: 'number'; value: DecimalString }
  | { type: 'money'; value: MinorUnits; currency: CurrencyCode }
  | { type: 'boolean'; value: boolean }
  | { type: 'date'; value: IsoDate }
  | { type: 'datetime'; value: IsoLocalDateTime; tz: TimeZone }
  | { type: 'time'; value: IsoTime }
  | { type: 'relative_date'; offset: number; unit: 'day' | 'week' | 'month' | 'year' }
  | { type: 'null' };

export type Operand =
  | { kind: 'ref'; ref: ValueRef }
  | { kind: 'literal'; value: Literal }
  /** Typed option picker: UI shows labels, stores ids of `blockId` (never labels). */
  | { kind: 'options'; blockId: BlockId; optionIds: OptionId[] }
  | { kind: 'expr'; expr: Expr };

/** Applicability per ComparableKind comes from the registry; publish rejects mismatches. */
export const LOGIC_OPERATORS = [
  'is_answered', 'is_not_answered',
  'eq', 'neq',                                         // text: case-insensitive + NFC fold by default; choice: set equality
  'contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with', 'matches_preset',
  'gt', 'gte', 'lt', 'lte', 'between',                 // number / money / rating — never lexicographic
  'before', 'after', 'on_or_before', 'on_or_after',    // date / time / datetime (UI aliases of lt/gt/lte/gte)
  'includes_any', 'includes_all', 'includes_none',     // choices
  'count_eq', 'count_gte', 'count_lte',                // choices / files / group rows
  'is_true', 'is_false',                               // booleans, consent items
] as const;
export type LogicOperator = (typeof LOGIC_OPERATORS)[number];

export interface Condition {
  kind: 'condition'; id: ConditionId;
  left: Operand; op: LogicOperator; right?: Operand; right2?: Operand /* between, inclusive */;
  caseSensitive?: boolean;
}
/** LOG-07/08. Depth ≤ 5, ≤ 100 leaves. Empty 'all' = true (always); empty 'any' = false. */
export interface ConditionGroup {
  kind: 'group'; id: ConditionId; combinator: 'all' | 'any'; negate?: boolean;
  children: Array<Condition | ConditionGroup>;
}

export type Recipient =
  | { kind: 'email'; address: EmailAddress }        // never allowed inside template payloads
  | { kind: 'field'; blockId: BlockId }
  | { kind: 'member'; userId: UserId }
  | { kind: 'role'; role: 'form_owner' | 'org_admins' | 'team_admins' };

export type ElementTarget = BlockId | PageId;

export type ClientAction =
  | { type: 'show' | 'hide'; targets: ElementTarget[] }                    // LOG-09 (blocks, sections, pages)
  | { type: 'require' | 'unrequire'; targets: BlockId[] }                  // LOG-10
  | { type: 'enable' | 'disable'; targets: BlockId[] }                     // LOG-11
  /** LOG-14/15/16: calculate, copy (expr = ref) or build text. Target is read-only while active. */
  | { type: 'set_value'; target: BlockId; path?: AnswerPath; value: Expr }
  | { type: 'clear_value'; targets: BlockId[] }
  | { type: 'set_variable'; varId: VariableId; value: Expr }               // LOG-20
  /** LOG-13: forward-only, applies when Next is pressed on `from`. */
  | { type: 'skip_to_page'; from: PageId; to: PageId }
  | { type: 'skip_to_end'; from: PageId; endingId?: EndingId }
  | { type: 'set_ending'; endingId: EndingId }                             // END-03, LOG-24
  /** VAL-13 cross-field validation. Blocks Next on `atPage` (or Submit). Message translatable `rule:<id>:<i>`. */
  | { type: 'block_submit'; message: string; atPage?: PageId; anchorBlockId?: BlockId }
  | { type: 'show_options' | 'hide_options'; target: BlockId; optionIds: OptionId[] };

export type ServerAction =
  | { type: 'route_email'; notificationId: NotificationId; field: 'to' | 'cc' | 'bcc' | 'reply_to'; mode: 'add' | 'replace'; recipients: Recipient[] } // NOT-10
  | { type: 'set_email_variant'; notificationId: NotificationId; variantId: NotificationVariantId }
  | { type: 'toggle_effect'; effect: { kind: 'notification'; id: NotificationId } | { kind: 'webhook'; id: WebhookId } | { kind: 'integration'; id: IntegrationId }; enabled: boolean }
  | { type: 'use_pdf_template'; notificationId: NotificationId; pdfTemplateId: PdfTemplateId }
  | { type: 'start_workflow'; workflowId: WorkflowId }                     // WFL-01/02
  | { type: 'tag_submission'; tags: string[] }                             // SUB-13
  | { type: 'assign_submission'; userId: UserId }                          // SUB-15
  | { type: 'mark_spam'; reason: string };                                 // SPM-03

export type Action = ClientAction | ServerAction;
export type ActionType = Action['type'];
export const SERVER_ONLY_ACTION_TYPES = ['route_email', 'set_email_variant', 'toggle_effect', 'use_pdf_template', 'start_workflow', 'tag_submission', 'assign_submission', 'mark_spam'] as const;
export type ServerOnlyActionType = (typeof SERVER_ONLY_ACTION_TYPES)[number];
type _ServerSplitOk = _ExactKeys<{ [K in ServerAction['type']]: 1 }, ServerOnlyActionType>;
export const _serverSplitOk: _ServerSplitOk = true;

export interface Rule<A extends Action = Action> {
  id: RuleId;
  name?: string;                     // LOG-02
  groupId?: RuleGroupId;
  enabled: boolean;
  when: ConditionGroup;
  then: A[];
  /** Applied when `when` is false. */
  else?: A[];
  /** Row scope: instantiated per row; refs with row:'current' bind to that row. */
  scope?: { repeatingGroupId: BlockId };
  origin?: Origin;
}

/** LOG-20 / LOG-24. Recomputed server-side; stored in submission.computed. */
export interface Variable {
  id: VariableId; key: FieldKey; name: string;
  type: ExprType; expr: Expr; format?: ValueFormat;
  persist: boolean;
  /** Taint (I13) is computed by compile(); lowering it needs a reason. */
  declassify?: { reason: string };
  origin?: Origin;
}

export interface LogicModel {
  /** Authored order = tie-break priority (later write wins among writers of the same cell). */
  rules: Rule[];
  ruleGroups: Array<{ id: RuleGroupId; name: string; collapsed?: boolean }>;
  variables: Variable[];
}
