import type {
  BlockId, EmailTemplatePayload, Ending, EndingId, EndingTemplatePayload, FieldKey, FormDefinition, FormTemplateBinding, FormTemplatePayload, Instantiate,
  InstantiateContext, InstantiateResult, Locale, NotificationConfig, NotificationId, PdfTemplateConfig, PdfTemplateId, PdfTemplatePayload, Recipient,
  StoredBlock, TemplateRef, TemplateVariable, TemplateVersion, TemplateVersionPayload, TemplateWarning, ThemeTemplatePayload, TranslationEntry,
  WorkflowDefinition, WorkflowId, WorkflowTemplatePayload,
} from '@form/schema';
import { TemplateCoreError } from './errors.ts';
import { applyOptionalParts, keptMessages, pruneRemoved, type Removed } from './parts.ts';
import { IDENTITY, cloneJson, remapRefs, remapTextKey, type Remap } from './remap.ts';
import { Baker, IdAllocator, OFFLINE_ACTOR, ROOT_SOURCE_ID, binding, conditionIds, origin, sensitiveWarning, type EngineOptions } from './shared.ts';
import { seedNamespace } from './uuid.ts';
import { variableNames } from './variables.ts';

type RefPayload<P> = { payload: P; version: TemplateVersion | null };
type Kind<K extends TemplateVersionPayload['kind']> = Extract<TemplateVersionPayload, { kind: K }>;

/** An inline ref payload, or the version a `TemplateRef` resolves to (null and a warning when it does not). */
function resolveRef<K extends TemplateVersionPayload['kind']>(
  ref: TemplateRef | Kind<K>, kind: K, options: EngineOptions, warnings: TemplateWarning[], at: string,
): RefPayload<Kind<K>> | null {
  if ('kind' in ref) return { payload: ref, version: null };
  const version = options.resolveRef?.(ref);
  if (version?.payload.kind === kind) return { payload: version.payload as Kind<K>, version };
  warnings.push({ code: 'feature_unavailable', message: `Referenced ${kind} template ${ref.templateId}@${ref.versionId} is not available`, at });
  return null;
}

/** Ids of the definition's own items, allocated in a fixed order (pages, blocks, endings, rules, groups, variables, purposes, conditions). */
function allocateDocument(def: FormDefinition, ids: IdAllocator): void {
  def.pages.forEach((p) => ids.alloc('element', p.id));
  Object.keys(def.blocks).forEach((id) => ids.alloc('element', id));
  def.endings.forEach((e) => ids.alloc('element', e.id));
  def.logic.rules.forEach((r) => ids.alloc('rule', r.id));
  def.logic.ruleGroups.forEach((g) => ids.alloc('rule_group', g.id));
  def.logic.variables.forEach((v) => ids.alloc('variable', v.id));
  def.privacy.purposes.forEach((p) => ids.alloc('purpose', p.id));
  conditionIds(def).forEach((c) => ids.alloc('condition', c));
}

/** The definition with every id remapped and every block, page, rule, variable, ending and purpose stamped. */
function remapDocument(def: FormDefinition, remap: Remap, bindingId: string): FormDefinition {
  const mapped = remapRefs(def, remap);
  const blocks: FormDefinition['blocks'] = {};
  for (const [sourceId, block] of Object.entries(mapped.blocks)) {
    if (!block) continue;
    const id = remap.id('element', sourceId) as BlockId;
    blocks[id] = (block.type === 'unsupported' ? { ...block, id } : { ...block, id, origin: origin(bindingId, sourceId) }) as StoredBlock;
  }
  return {
    ...mapped,
    blocks,
    pages: mapped.pages.map((p) => ({ ...p, id: remap.id('element', p.id) as typeof p.id, origin: origin(bindingId, p.id) })),
    endings: mapped.endings.map((e) => ({ ...e, id: remap.id('element', e.id) as EndingId, origin: origin(bindingId, e.id) })),
    logic: {
      rules: mapped.logic.rules.map((r) => ({ ...r, id: remap.id('rule', r.id) as typeof r.id, origin: origin(bindingId, r.id) })),
      ruleGroups: mapped.logic.ruleGroups.map((g) => ({ ...g, id: remap.id('rule_group', g.id) as typeof g.id })),
      variables: mapped.logic.variables.map((v) => ({ ...v, id: remap.id('variable', v.id) as typeof v.id, origin: origin(bindingId, v.id) })),
    },
    privacy: { ...mapped.privacy, purposes: mapped.privacy.purposes.map((p) => ({ ...p, id: remap.id('purpose', p.id) as typeof p.id, origin: origin(bindingId, p.id) })) },
  };
}

/**
 * The form's locales: the template's, limited to its default locale, `ctx.locale` and `ctx.extraLocales`.
 * Translations are copied (document entries win over payload entries; `tplvar:` keys stay with the template, keys about
 * what an optional part removed are dropped), keys remapped, marked `origin: 'template'`.
 */
function instanceI18n(def: FormDefinition, payload: FormTemplatePayload, ctx: InstantiateContext, remap: Remap, removed: Removed, warnings: TemplateWarning[]): FormDefinition['i18n'] {
  const i18n = def.i18n;
  const wanted = new Set<string>([i18n.defaultLocale, ctx.locale, ...ctx.extraLocales]);
  const available = [...i18n.locales];
  for (const l of payload.i18n.locales) if (!available.some((a) => a.locale === l.locale)) available.push(l);
  const locales = available.filter((l) => wanted.has(l.locale));
  for (const locale of wanted) {
    if (!locales.some((l) => l.locale === locale)) warnings.push({ code: 'locale_incomplete', message: `The template has no ${locale} translation; the form starts in ${i18n.defaultLocale}`, at: locale });
  }
  const kept = new Set<string>(locales.map((l) => l.locale));
  const messages: FormDefinition['i18n']['messages'] = {};
  /* `def` is already remapped; the payload's own messages are not. */
  for (const [source, map] of [[keptMessages(payload.i18n.messages, removed), remap], [i18n.messages, IDENTITY]] as const) {
    for (const [locale, entries] of Object.entries(source)) {
      if (!kept.has(locale) || locale === i18n.defaultLocale || !entries) continue;
      const out: Partial<Record<string, TranslationEntry>> = { ...messages[locale as Locale] };
      for (const [key, entry] of Object.entries(entries)) {
        if (!entry || key.startsWith('tplvar:')) continue;
        out[remapTextKey(key, remap)] = { ...remapRefs(entry, map), origin: 'template' };
      }
      messages[locale as Locale] = out;
    }
  }
  const filter = <T>(record: Partial<Record<Locale, T>>) => Object.fromEntries(Object.entries(record).filter(([l]) => kept.has(l))) as Partial<Record<Locale, T>>;
  return {
    ...i18n,
    locales,
    messages,
    systemMessages: filter(i18n.systemMessages),
    reviewedConsentLocales: i18n.reviewedConsentLocales.filter((l) => kept.has(l)),
  };
}

const EMAIL_TRIGGERS: Partial<Record<EmailTemplatePayload['role'], Pick<NotificationConfig, 'kind' | 'trigger'>>> = {
  notification: { kind: 'owner', trigger: 'submitted' },
  autoresponder: { kind: 'autoresponder', trigger: 'submitted' },
  edit_notice: { kind: 'owner', trigger: 'edited' },
};

/** Blocks in render order: pages, then each container's children. */
function documentOrder(def: FormDefinition): StoredBlock[] {
  const out: StoredBlock[] = [];
  const visit = (id: BlockId) => {
    const block = def.blocks[id];
    if (!block || out.includes(block)) return;
    out.push(block);
    if (block.type === 'section' || block.type === 'repeating_group') block.config.children.forEach(visit);
  };
  def.pages.forEach((p) => p.children.forEach(visit));
  return out;
}

/** An email template as a form notification; an autoresponder without recipients goes to the first email field. */
function notificationOf(email: EmailTemplatePayload, id: string, bindingId: string, def: FormDefinition, locale: Locale): NotificationConfig | null {
  const role = EMAIL_TRIGGERS[email.role];
  if (!role) return null;
  const firstEmail = documentOrder(def).find((b) => b.type === 'email');
  const to: Recipient[] = email.defaultRecipients?.length
    ? email.defaultRecipients
    : (role.kind === 'owner' ? [{ kind: 'role', role: 'form_owner' }] : firstEmail ? [{ kind: 'field', blockId: firstEmail.id }] : []);
  const hasDpdpConsent = Object.values(def.blocks).some((b) => b?.type === 'consent' && b.config.mode === 'dpdp');
  return {
    id: id as NotificationId,
    name: email.role,
    ...role,
    enabled: true,
    to,
    ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    purposeIds: def.privacy.purposes.map((p) => p.id),
    subject: email.subject,
    body: email.body,
    locale: role.kind === 'autoresponder' ? 'respondent' : locale,
    includeWithdrawalLink: email.includeWithdrawalLink ?? (role.kind === 'autoresponder' && hasDpdpConsent),
    origin: origin(bindingId, ROOT_SOURCE_ID),
  };
}

function thankYouEnding(ending: EndingTemplatePayload, id: string, bindingId: string): Ending {
  const base = { id: id as EndingId, name: ending.role, origin: origin(bindingId, ROOT_SOURCE_ID) };
  if (ending.redirect) return { ...base, kind: 'redirect', url: ending.redirect, message: ending.content };
  return { ...base, kind: 'message', content: ending.content, actions: ending.actions, ...(ending.confetti !== undefined ? { confetti: ending.confetti } : {}) };
}

/**
 * `instantiate(version, ctx)` (templates spec §3.1): a `form` template becomes a new draft. Ids are
 * `uuidv5(idSeed, sourceId)`, so the offline builder and the API produce the same bytes; option ids are kept;
 * every reference is remapped; origin stamps point at the bindings; `bake` variables are substituted; optional
 * parts whose condition is false are removed, and what pointed at them is pruned from the definition and from
 * every applied ref (or reported as `part_removed_rule` when it cannot be); the included refs (theme, endings and status screens, emails,
 * PDFs, workflow) are applied, each with its own binding. Access control, integrations, webhooks and
 * analytics ids are never copied. `options` (beyond the §19 signature) carries the binding actor and a
 * resolver for refs given as `TemplateRef`. Pure: the result depends only on its arguments.
 */
export const instantiate = ((version: TemplateVersion, ctx: InstantiateContext, options: EngineOptions = {}): InstantiateResult => {
  const payload = version.payload;
  if (payload.kind !== 'form') throw new TemplateCoreError('wrong_template_kind', `instantiate needs a form template, not '${payload.kind}'`);
  const actor = options.actor ?? OFFLINE_ACTOR;
  const ids = new IdAllocator(seedNamespace(ctx.idSeed));
  const bindingIds = new IdAllocator(seedNamespace(ctx.bindingIdSeed));
  const warnings: TemplateWarning[] = [];

  const parts = applyOptionalParts(payload.document, payload.optionalParts ?? [], ctx.variables, payload.variables);
  const source = parts.definition;
  warnings.push(...parts.warnings);

  const refs = payload.refs ?? {};
  const theme = ctx.include.theme && refs.theme ? resolveRef(refs.theme, 'theme', options, warnings, '/refs/theme') : null;
  const list = <K extends 'ending' | 'email' | 'pdf'>(items: ReadonlyArray<TemplateRef | Kind<K>> | undefined, kind: K, include: boolean, at: string) =>
    include ? (items ?? []).map((ref, i) => resolveRef(ref, kind, options, warnings, `${at}/${i}`)) : [];
  const endings = list<'ending'>(refs.endings, 'ending', ctx.include.endings, '/refs/endings');
  const emails = list<'email'>(refs.emails, 'email', ctx.include.emails, '/refs/emails');
  const pdfs = list<'pdf'>(refs.pdf, 'pdf', ctx.include.pdf, '/refs/pdf');
  const workflow = ctx.include.workflow && refs.workflow ? resolveRef(refs.workflow, 'workflow', options, warnings, '/refs/workflow') : null;

  const applied: Array<RefPayload<TemplateVersionPayload>> = [];
  for (const r of [theme, ...endings, ...emails, ...pdfs, workflow]) if (r) applied.push(r);
  const declared: TemplateVariable[] = [...payload.variables, ...applied.flatMap((r) => r.payload.variables)];
  const baker = new Baker(declared, { ...ctx, formTitle: source.title }, variableNames([source, ...applied.map((r) => r.payload)]));

  const formBindingId = bindingIds.named('form');
  allocateDocument(source, ids);
  const keyMap: Record<string, FieldKey> = {};
  for (const block of Object.values(source.blocks)) if (block && 'key' in block) keyMap[block.key] = block.key;
  for (const v of source.logic.variables) keyMap[v.key] = v.key;
  const remap = ids.remap();
  const remapped = remapDocument(source, remap, formBindingId);
  const defaultLocale = remapped.i18n.defaultLocale;

  const { analytics: _analytics, ...behavior } = remapped.behavior;
  let definition: FormDefinition = baker.bake({ ...remapped, formId: ctx.newFormId, behavior, i18n: { ...remapped.i18n, messages: {} } }, defaultLocale);
  const i18n = instanceI18n(remapped, payload, ctx, remap, parts.removed, warnings);
  const messages: FormDefinition['i18n']['messages'] = {};
  for (const [locale, entries] of Object.entries(i18n.messages)) messages[locale as Locale] = baker.bake(entries, locale as Locale);
  definition = { ...definition, i18n: { ...i18n, messages } };

  const bindings: FormTemplateBinding[] = [binding(formBindingId, 'form', version, ctx.newFormId, actor, ctx.now, ids.idMap, { keyMap })];
  const refBinding = (kind: FormTemplateBinding['kind'], name: string, ref: RefPayload<TemplateVersionPayload>, instanceRootId?: string) => {
    const id = bindingIds.named(name);
    const map: Record<string, string> = instanceRootId === undefined ? {} : { [ROOT_SOURCE_ID]: instanceRootId };
    bindings.push(binding(id, kind, ref.version ?? version, ctx.newFormId, actor, ctx.now, map, instanceRootId === undefined ? {} : { instanceRootId }));
    return id;
  };
  /* A ref's content may point at the form's blocks (recipients, pipes): same pruning, remap and bake. */
  const content = <T>(value: T, at: string): T => baker.bake(remapRefs(pruneRemoved(value, parts.removed, at, warnings), remap), defaultLocale);

  if (theme) {
    const t: ThemeTemplatePayload = theme.payload;
    refBinding('theme', 'theme', theme);
    definition = {
      ...definition,
      theme: {
        ...(theme.version ? { presetRef: { templateId: theme.version.templateId, versionId: theme.version.id } } : {}),
        layout: t.layout,
        tokens: cloneJson(t.tokens),
        ...(t.customCss !== undefined ? { customCss: t.customCss } : {}),
      },
    };
  }

  const ops: InstantiateResult['ops'] = { notifications: [], pdfTemplates: [], screens: {} };
  endings.forEach((ref, i) => {
    if (!ref) return;
    const ending = content(ref.payload, `/refs/endings/${i}`);
    if (ending.role === 'thank_you') {
      const id = ids.named(`refs/endings/${i}`);
      const bindingId = refBinding('ending', `ending/${i}`, ref, id);
      definition = { ...definition, endings: [...definition.endings, thankYouEnding(ending, id, bindingId)] };
    } else if (ops.screens[ending.role]) {
      warnings.push({ code: 'feature_unavailable', message: `An earlier ending ref already fills the '${ending.role}' screen; this one is skipped`, at: `/refs/endings/${i}` });
    } else {
      const bindingId = refBinding('ending', `ending/${i}`, ref, ending.role);
      ops.screens[ending.role] = { content: ending.content, origin: origin(bindingId, ROOT_SOURCE_ID) };
    }
  });
  emails.forEach((ref, i) => {
    if (!ref) return;
    const id = ids.named(`refs/emails/${i}`);
    const notification = notificationOf(content(ref.payload, `/refs/emails/${i}`), id, bindingIds.named(`email/${i}`), definition, ctx.locale);
    if (!notification) {
      warnings.push({ code: 'feature_unavailable', message: `Email role '${ref.payload.role}' is a system email, not a form notification`, at: `/refs/emails/${i}` });
      return;
    }
    refBinding('email', `email/${i}`, ref, id);
    ops.notifications.push(notification);
  });
  pdfs.forEach((ref, i) => {
    if (!ref) return;
    const id = ids.named(`refs/pdf/${i}`);
    const bindingId = refBinding('pdf', `pdf/${i}`, ref, id);
    const layout: PdfTemplatePayload['layout'] = content(ref.payload, `/refs/pdf/${i}`).layout;
    const pdf: PdfTemplateConfig = { ...layout, id: id as PdfTemplateId, name: `PDF ${i + 1}`, origin: origin(bindingId, ROOT_SOURCE_ID) };
    ops.pdfTemplates.push(pdf);
  });
  let workflowOut: WorkflowDefinition | undefined;
  if (workflow) {
    const wf: WorkflowTemplatePayload['workflow'] = content(workflow.payload, '/refs/workflow').workflow;
    const id = ids.named(`refs/workflow/${wf.id}`);
    refBinding('workflow', 'workflow', workflow, id);
    workflowOut = { ...wf, id: id as WorkflowId };
  }

  warnings.push(...sensitiveWarning(Object.values(definition.blocks).filter((b): b is StoredBlock => b !== undefined)), ...baker.warnings(defaultLocale));
  return { definition, ops, bindings, ...(workflowOut ? { workflow: workflowOut } : {}), warnings };
}) satisfies Instantiate;
