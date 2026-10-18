import { z } from 'zod';
import type { ConditionGroup } from '../logic.ts';
import { LOGIC_OPERATORS, SERVER_ONLY_ACTION_TYPES } from '../logic.ts';
import type { Expr, ScalarValue } from '../expr.ts';
import { EXPR_FUNCTIONS } from '../expr.ts';
import { depthGuard, guarded, keyed } from './_util.ts';
import {
  BlockIdSchema, ConditionIdSchema, CurrencyCodeSchema, DecimalStringSchema, EmailAddressSchema, EndingIdSchema, FieldKeySchema,
  IntegrationIdSchema, IsoDateSchema, IsoLocalDateTimeSchema, IsoTimeSchema, MinorUnitsSchema, NotificationIdSchema,
  NotificationVariantIdSchema, OptionIdSchema, OriginSchema, PageIdSchema, PdfTemplateIdSchema, RuleGroupIdSchema, RuleIdSchema,
  TimeZoneSchema, UserIdSchema, VariableIdSchema, WebhookIdSchema, WorkflowIdSchema,
} from './primitives.ts';
import { AnswerPathSchema, ValueFormatSchema, ValueRefSchema } from './rich-text.ts';

/*
 * Recursion goes through these unguarded nodes and the unexported shapes below. Every exported schema that can reach one
 * runs the depth guard first, so hostile nesting is a parse error, never a stack overflow.
 */
const ExprNode: z.ZodType<Expr> = z.lazy(() => ExprShape);
/* zod's lazy forwards `propValues` at runtime, so the group node can sit in a discriminated union. */
const ConditionGroupNode = z.lazy(() => ConditionGroupShape) as z.ZodType<ConditionGroup> & z.core.$ZodTypeDiscriminable;
const ScalarValueNode: z.ZodType<ScalarValue> = z.lazy(() => ScalarValueShape);

/* §9 */

const dateUnit = z.enum(['day', 'week', 'month', 'year']);
export const LiteralSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), value: z.string().max(10_000) }),
  z.strictObject({ type: z.literal('number'), value: DecimalStringSchema }),
  z.strictObject({ type: z.literal('money'), value: MinorUnitsSchema, currency: CurrencyCodeSchema }),
  z.strictObject({ type: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ type: z.literal('date'), value: IsoDateSchema }),
  z.strictObject({ type: z.literal('datetime'), value: IsoLocalDateTimeSchema, tz: TimeZoneSchema }),
  z.strictObject({ type: z.literal('time'), value: IsoTimeSchema }),
  z.strictObject({ type: z.literal('relative_date'), offset: z.number().int(), unit: dateUnit }),
  z.strictObject({ type: z.literal('null') }),
]);

export const ScalarTypeSchema = z.enum(['number', 'money', 'text', 'boolean', 'date', 'time', 'datetime', 'duration', 'option']);

const ScalarValueShape = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('number'), v: DecimalStringSchema }),
  z.strictObject({ t: z.literal('money'), v: MinorUnitsSchema, currency: CurrencyCodeSchema }),
  z.strictObject({ t: z.literal('text'), v: z.string() }),
  z.strictObject({ t: z.literal('boolean'), v: z.boolean() }),
  z.strictObject({ t: z.literal('date'), v: IsoDateSchema }),
  z.strictObject({ t: z.literal('time'), v: IsoTimeSchema }),
  z.strictObject({ t: z.literal('datetime'), v: IsoLocalDateTimeSchema, tz: TimeZoneSchema }),
  z.strictObject({ t: z.literal('duration'), v: z.strictObject({ days: z.number().int(), minutes: z.number().int() }) }),
  z.strictObject({ t: z.literal('option'), blockId: BlockIdSchema, v: OptionIdSchema }),
  z.strictObject({ t: z.literal('list'), of: ScalarTypeSchema, items: z.array(ScalarValueNode).max(10_000) }),
  z.strictObject({ t: z.literal('null') }),
]);
export const ScalarValueSchema = guarded(depthGuard, ScalarValueShape);

export const BinaryOpSchema = z.enum(['+', '-', '*', '/', '%', '^', '&', '==', '!=', '<', '<=', '>', '>=', 'and', 'or']);
export const ExprFunctionSchema = z.enum(EXPR_FUNCTIONS);

const ExprShape = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('lit'), value: LiteralSchema }),
  z.strictObject({ k: z.literal('ref'), ref: ValueRefSchema }),
  z.strictObject({ k: z.literal('unary'), op: z.enum(['neg', 'not']), arg: ExprNode }),
  z.strictObject({ k: z.literal('binary'), op: BinaryOpSchema, left: ExprNode, right: ExprNode }),
  z.strictObject({ k: z.literal('if'), cond: z.union([ExprNode, ConditionGroupNode]), then: ExprNode, else: ExprNode }),
  z.strictObject({ k: z.literal('call'), fn: ExprFunctionSchema, args: z.array(ExprNode) }),
  z.strictObject({ k: z.literal('list'), items: z.array(ExprNode).max(10_000) }),
]);
/** Stored AST only. Size limits (≤ 500 nodes, depth ≤ 32) are the publish check `expr_too_large`. */
export const ExprSchema = guarded(depthGuard, ExprShape);

const OperandNode = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ref'), ref: ValueRefSchema }),
  z.strictObject({ kind: z.literal('literal'), value: LiteralSchema }),
  z.strictObject({ kind: z.literal('options'), blockId: BlockIdSchema, optionIds: z.array(OptionIdSchema) }),
  z.strictObject({ kind: z.literal('expr'), expr: ExprNode }),
]);
export const OperandSchema = guarded(depthGuard, OperandNode);

export const LogicOperatorSchema = z.enum(LOGIC_OPERATORS);

const ConditionNode = z.strictObject({
  kind: z.literal('condition'),
  id: ConditionIdSchema,
  left: OperandNode,
  op: LogicOperatorSchema,
  right: OperandNode.exactOptional(),
  right2: OperandNode.exactOptional(),
  caseSensitive: z.boolean().exactOptional(),
});
export const ConditionSchema = guarded(depthGuard, ConditionNode);
const ConditionGroupShape = z.strictObject({
  kind: z.literal('group'),
  id: ConditionIdSchema,
  combinator: z.enum(['all', 'any']),
  negate: z.boolean().exactOptional(),
  children: z.array(z.discriminatedUnion('kind', [ConditionNode, ConditionGroupNode])),
});
export const ConditionGroupSchema = guarded(depthGuard, ConditionGroupShape);

export const RecipientSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('email'), address: EmailAddressSchema }),
  z.strictObject({ kind: z.literal('field'), blockId: BlockIdSchema }),
  z.strictObject({ kind: z.literal('member'), userId: UserIdSchema }),
  z.strictObject({ kind: z.literal('role'), role: z.enum(['form_owner', 'org_admins', 'team_admins']) }),
]);

export const ElementTargetSchema = z.union([BlockIdSchema, PageIdSchema]);

export const ClientActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.enum(['show', 'hide']), targets: z.array(ElementTargetSchema) }),
  z.strictObject({ type: z.enum(['require', 'unrequire']), targets: z.array(BlockIdSchema) }),
  z.strictObject({ type: z.enum(['enable', 'disable']), targets: z.array(BlockIdSchema) }),
  z.strictObject({ type: z.literal('set_value'), target: BlockIdSchema, path: AnswerPathSchema.exactOptional(), value: ExprSchema }),
  z.strictObject({ type: z.literal('clear_value'), targets: z.array(BlockIdSchema) }),
  z.strictObject({ type: z.literal('set_variable'), varId: VariableIdSchema, value: ExprSchema }),
  z.strictObject({ type: z.literal('skip_to_page'), from: PageIdSchema, to: PageIdSchema }),
  z.strictObject({ type: z.literal('skip_to_end'), from: PageIdSchema, endingId: EndingIdSchema.exactOptional() }),
  z.strictObject({ type: z.literal('set_ending'), endingId: EndingIdSchema }),
  z.strictObject({ type: z.literal('block_submit'), message: z.string().min(1).max(1000), atPage: PageIdSchema.exactOptional(), anchorBlockId: BlockIdSchema.exactOptional() }),
  z.strictObject({ type: z.enum(['show_options', 'hide_options']), target: BlockIdSchema, optionIds: z.array(OptionIdSchema) }),
]);

export const ServerActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('route_email'),
    notificationId: NotificationIdSchema,
    field: z.enum(['to', 'cc', 'bcc', 'reply_to']),
    mode: z.enum(['add', 'replace']),
    recipients: z.array(RecipientSchema),
  }),
  z.strictObject({ type: z.literal('set_email_variant'), notificationId: NotificationIdSchema, variantId: NotificationVariantIdSchema }),
  z.strictObject({
    type: z.literal('toggle_effect'),
    effect: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('notification'), id: NotificationIdSchema }),
      z.strictObject({ kind: z.literal('webhook'), id: WebhookIdSchema }),
      z.strictObject({ kind: z.literal('integration'), id: IntegrationIdSchema }),
    ]),
    enabled: z.boolean(),
  }),
  z.strictObject({ type: z.literal('use_pdf_template'), notificationId: NotificationIdSchema, pdfTemplateId: PdfTemplateIdSchema }),
  z.strictObject({ type: z.literal('start_workflow'), workflowId: WorkflowIdSchema }),
  z.strictObject({ type: z.literal('tag_submission'), tags: z.array(z.string().min(1).max(64)) }),
  z.strictObject({ type: z.literal('assign_submission'), userId: UserIdSchema }),
  z.strictObject({ type: z.literal('mark_spam'), reason: z.string().max(500) }),
]);

export const ActionSchema = z.discriminatedUnion('type', [ClientActionSchema, ServerActionSchema]);
export const ActionTypeSchema = z.enum([
  'show', 'hide', 'require', 'unrequire', 'enable', 'disable', 'set_value', 'clear_value', 'set_variable', 'skip_to_page',
  'skip_to_end', 'set_ending', 'block_submit', 'show_options', 'hide_options', ...SERVER_ONLY_ACTION_TYPES,
]);
export const ServerOnlyActionTypeSchema = z.enum(SERVER_ONLY_ACTION_TYPES);

/** Twin of Rule<A> for a given action schema. */
export const ruleSchema = <A extends z.ZodType>(action: A) => z.strictObject({
  id: RuleIdSchema,
  name: z.string().max(200).exactOptional(),
  groupId: RuleGroupIdSchema.exactOptional(),
  enabled: z.boolean(),
  when: ConditionGroupSchema,
  then: z.array(action),
  else: z.array(action).exactOptional(),
  scope: z.strictObject({ repeatingGroupId: BlockIdSchema }).exactOptional(),
  origin: OriginSchema.exactOptional(),
});
export const RuleSchema = ruleSchema(ActionSchema);
export const ClientRuleSchema = ruleSchema(ClientActionSchema);

/* §10 */

export const ExprTypeSchema = z.union([ScalarTypeSchema, z.strictObject({ list: ScalarTypeSchema }), z.literal('null')]);

export const VariableSchema = z.strictObject({
  id: VariableIdSchema,
  key: FieldKeySchema,
  name: z.string().min(1).max(200),
  type: ExprTypeSchema,
  expr: ExprSchema,
  format: ValueFormatSchema.exactOptional(),
  persist: z.boolean(),
  declassify: z.strictObject({ reason: z.string().min(1).max(1000) }).exactOptional(),
  origin: OriginSchema.exactOptional(),
});

export const LogicModelSchema = z.strictObject({
  rules: z.array(RuleSchema),
  ruleGroups: z.array(z.strictObject({ id: RuleGroupIdSchema, name: z.string().max(200), collapsed: z.boolean().exactOptional() })),
  variables: z.array(VariableSchema),
});

export const ExprFunctionSignatureSchema = z.strictObject({
  params: z.array(z.union([ExprTypeSchema, z.literal('any'), z.literal('block_ref')])),
  rest: z.union([ExprTypeSchema, z.literal('any')]).exactOptional(),
  returns: z.union([ExprTypeSchema, z.literal('same_as_first')]),
  pure: z.boolean(),
});
export const ExprFunctionTableSchema = keyed(z.record(ExprFunctionSchema, ExprFunctionSignatureSchema)).readonly();
