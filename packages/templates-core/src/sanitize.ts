import { INPUT_FIELD_TYPES, SCHEMA_VERSION, jsonPointer } from '@form/schema';
import type {
  DataClassification, DataInventoryEntry, EmailTemplatePayload, FieldBlock, EndingTemplatePayload, FeatureId, FormDefinition, FormId, FormOps, FormTemplatePayload, Locale,
  OrgProfile, PdfTemplatePayload, Recipient, RecipientPlaceholder, SanitizeForTemplate, StatusScreenRole, TemplateVariable, TemplateVariableName,
} from '@form/schema';
import { scanPii, type PiiKind } from './pii.ts';
import { isOpaque, isRec, type Rec } from './remap.ts';
import { sensitiveWarning } from './shared.ts';
import { orgValue, variableNames } from './variables.ts';

/** The placeholder `formId` of a form template's document (templates spec §1: "formId is a placeholder"). */
export const TEMPLATE_FORM_ID = 'template_form' as FormId;

type Hit = { path: string; kind: PiiKind };

const ORG_NAMES = [
  'org.legal_name', 'org.display_name', 'org.cin', 'org.gstin', 'org.registered_address', 'org.website', 'org.support_email', 'org.support_phone',
  'org.privacy_policy_url', 'org.terms_url', 'org.rights_url', 'org.board_complaint_info', 'org.privacy_contact.name', 'org.privacy_contact.designation',
  'org.privacy_contact.email', 'org.privacy_contact.phone', 'org.privacy_contact.address', 'org.dpo.name', 'org.dpo.email', 'org.dpo.phone',
] as const satisfies readonly TemplateVariableName[];

/** Org-profile values worth generalising (3+ characters), longest first so a legal name wins over a display name inside it. */
function orgValues(profile: OrgProfile, locale: Locale): Array<[TemplateVariableName, string]> {
  const out: Array<[TemplateVariableName, string]> = [];
  for (const name of ORG_NAMES) {
    const value = orgValue(name, profile, locale);
    if (value !== undefined && value.length >= 3 && !out.some(([, v]) => v === value)) out.push([name, value]);
  }
  return out.sort((a, b) => b[1].length - a[1].length);
}

/** `text` split around every occurrence of an org value: strings and variable names. */
function splitOrg(text: string, values: ReadonlyArray<[TemplateVariableName, string]>): Array<string | { name: TemplateVariableName }> {
  const out: Array<string | { name: TemplateVariableName }> = [];
  let plain = '';
  for (let i = 0; i < text.length;) {
    const hit = values.find(([, v]) => text.startsWith(v, i));
    if (hit) {
      if (plain) out.push(plain);
      plain = '';
      out.push({ name: hit[0] });
      i += hit[1].length;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) out.push(plain);
  return out;
}

/** Org values in rich-text text nodes become `var` nodes (the "Generalise org values" step). */
function generaliseRich(value: unknown, values: ReadonlyArray<[TemplateVariableName, string]>): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => {
      if (isRec(item) && item['type'] === 'text' && typeof item['text'] === 'string') {
        return splitOrg(item['text'], values).map((part) => (typeof part === 'string' ? { ...item, text: part } : { type: 'var', attrs: { name: part.name } }));
      }
      return [generaliseRich(item, values)];
    });
  }
  if (!isRec(value)) return value;
  const out: Rec = {};
  for (const [k, v] of Object.entries(value)) out[k] = isOpaque(value, k) ? v : generaliseRich(v, values);
  return out;
}

/** The same for a plain template (`['Contact ', 'privacy@acme.example']` → `['Contact ', { var: { name: 'org.privacy_contact.email' } }]`). */
function generalisePlain<T extends ReadonlyArray<unknown> | undefined>(template: T, values: ReadonlyArray<[TemplateVariableName, string]>): T {
  if (!template) return template;
  return template.flatMap((item) => (typeof item === 'string' ? splitOrg(item, values).map((part) => (typeof part === 'string' ? part : { var: { name: part.name } })) : [item])) as unknown as T;
}

/** Template origin stamps of the source form (they point at its own bindings) are dropped. */
function stripOrigins<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isRec(v)) return v;
    const out: Rec = {};
    for (const [k, child] of Object.entries(v)) {
      if (isOpaque(v, k)) out[k] = child;
      else if (!(k === 'origin' && isRec(child))) out[k] = walk(child);
    }
    return out;
  };
  return walk(value) as T;
}

const FORM_OWNER: RecipientPlaceholder = { kind: 'role', role: 'form_owner' };

/** Literal recipients (an address, a member) become the form-owner placeholder; a literal address is a hit. */
function placeholder(recipient: Recipient, path: string, hits: Hit[]): RecipientPlaceholder {
  if (recipient.kind === 'email') hits.push({ path, kind: 'email' });
  return recipient.kind === 'email' || recipient.kind === 'member' ? FORM_OWNER : recipient;
}

function placeholdersIn<T>(value: T, base: string, hits: Hit[]): T {
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((item: unknown, i) => walk(item, `${path}/${i}`));
    if (!isRec(v)) return v;
    if ((v['kind'] === 'email' && typeof v['address'] === 'string') || (v['kind'] === 'member' && typeof v['userId'] === 'string')) return placeholder(v as Recipient, path, hits);
    const out: Rec = {};
    for (const [k, child] of Object.entries(v)) out[k] = isOpaque(v, k) ? child : walk(child, `${path}/${jsonPointer(k).slice(1)}`);
    return out;
  };
  return walk(value, base) as T;
}

/** Keys whose strings are ids, keys, enums or hashes, never author text. */
const NOT_TEXT = /^(id|key|keys|carryKeys|type|kind|op|sourceHash|origin|children|targets?|atPage|pageId|endingId|defaultEndingId|repeatingGroupId|varId|groupId|[a-z][A-Za-z]*Ids?)$/;

/**
 * Every PII pattern in the author text of `value` (string leaves outside id, key and enum positions), by JSON
 * pointer. Opaque payloads (`x-*` extensions, an unsupported block's `raw`) are carried into the template
 * verbatim, so every key and string inside them is scanned.
 */
function scanTree(value: unknown, base: string, hits: Hit[]): void {
  const scan = (text: string, path: string) => {
    for (const m of scanPii(text)) hits.push({ path, kind: m.kind });
  };
  const opaque = (v: unknown, path: string): void => {
    if (typeof v === 'string') scan(v, path);
    else if (Array.isArray(v)) v.forEach((item: unknown, i) => opaque(item, `${path}/${i}`));
    else if (isRec(v)) {
      for (const [k, child] of Object.entries(v)) {
        const at = `${path}/${jsonPointer(k).slice(1)}`;
        scan(k, at);
        opaque(child, at);
      }
    }
  };
  const walk = (v: unknown, path: string, key: string | null): void => {
    if (typeof v === 'string') {
      if (key === null || !NOT_TEXT.test(key)) scan(v, path);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item: unknown, i) => walk(item, `${path}/${i}`, key));
      return;
    }
    if (!isRec(v)) return;
    for (const [k, child] of Object.entries(v)) {
      const at = `${path}/${jsonPointer(k).slice(1)}`;
      if (isOpaque(v, k)) opaque(child, at);
      else walk(child, at, k);
    }
  };
  walk(value, base, null);
}

const SOURCES = { org: 'org_profile', brand: 'brand_kit', form: 'form', custom: 'prompt' } as const;
const BRAND_TYPES: Readonly<Record<string, TemplateVariable['type']>> = {
  'brand.logo': 'image', 'brand.logo_dark': 'image', 'brand.logo_square': 'image', 'brand.favicon': 'image', 'brand.email_header': 'rich',
  'brand.email_footer': 'rich', 'brand.pdf_footer': 'rich', 'brand.legal_footer': 'rich',
};

/** Declarations for the variables a payload uses: `custom.*` prompts bake, the rest stay live. */
function declare(value: unknown): TemplateVariable[] {
  return variableNames(value).map((name) => {
    const prefix = name.slice(0, name.indexOf('.')) as keyof typeof SOURCES;
    const color = /^brand\.(primary|secondary|accent|background|surface|text|muted|error|success)$/.test(name);
    return { name, source: SOURCES[prefix], type: color ? 'color' : BRAND_TYPES[name] ?? 'text', label: name, required: false, binding: prefix === 'custom' ? 'bake' : 'live' };
  });
}

const RANK: Readonly<Record<DataClassification, number>> = { none: 0, personal: 1, sensitive: 2 };

/** Data inventory per purpose: the value fields that declare it, their highest classification and whether all are encrypted. */
function dataInventory(def: FormDefinition): DataInventoryEntry[] {
  return def.privacy.purposes.map((purpose) => {
    const fields = Object.values(def.blocks).filter((b): b is FieldBlock => b !== undefined && b.type !== 'unsupported' && 'compliance' in b && b.compliance.purposeIds.includes(purpose.id));
    const compliance = fields.map((b) => b.compliance);
    const classification = compliance.reduce<DataClassification>((max, c) => (RANK[c.classification] > RANK[max] ? c.classification : max), 'none');
    const r = purpose.retention;
    const days = r.kind === 'days' || r.kind === 'inactivity' ? r.days : r.kind === 'until_purpose_served' ? r.maxDays : undefined;
    return {
      purposeName: purpose.name,
      fieldSourceIds: fields.map((b) => b.id as string),
      classification,
      ...(days !== undefined ? { suggestedRetentionDays: days } : {}),
      encrypted: compliance.length > 0 && compliance.every((c) => c.encrypt),
    };
  });
}

const INPUTS: ReadonlySet<string> = new Set(INPUT_FIELD_TYPES.filter((t) => t !== 'hidden'));

/**
 * The pure parts of the save-as-template sanitiser (templates spec §5.3): the form becomes a `form` payload
 * with a placeholder form id and no origin stamps; access control, schedule, limits, integrations, webhooks,
 * payments, retention ops and analytics ids are not carried; notifications, PDF templates and status screens
 * become inline refs; literal recipients become placeholders (each literal address reported); org-profile
 * values become `org.*` variables; and every remaining email address, Indian phone number, PAN, Aadhaar
 * number (Verhoeff-checked) and GSTIN in author text, and in the opaque `x-*` and unsupported-block payloads
 * that are carried verbatim, is reported in `piiHits` for the author to clear or acknowledge before the save. Assets, PII re-tagging and taint are the server's part.
 */
export const sanitizeForTemplate: SanitizeForTemplate = (def, ops, orgProfile) => {
  const hits: Hit[] = [];
  const locale = def.i18n.defaultLocale;
  const values = orgValues(orgProfile, locale);
  const common = (variablesOf: unknown) => ({
    schemaVersion: SCHEMA_VERSION,
    variables: declare(variablesOf),
    locks: [],
    requiredFeatures: [],
    i18n: { defaultLocale: locale, locales: def.i18n.locales.filter((l) => l.locale === locale), messages: {} },
  });

  const { analytics: _analytics, ...behavior } = def.behavior;
  const fiduciary = def.privacy.fiduciary;
  const generalisedFiduciary: FormDefinition['privacy']['fiduciary'] = {
    ...fiduciary,
    legalName: generalisePlain(fiduciary.legalName, values),
    contactEmail: generalisePlain(fiduciary.contactEmail, values),
    privacyContact: {
      name: generalisePlain(fiduciary.privacyContact.name, values),
      email: generalisePlain(fiduciary.privacyContact.email, values),
      ...(fiduciary.privacyContact.phone ? { phone: generalisePlain(fiduciary.privacyContact.phone, values) } : {}),
    },
    ...(fiduciary.dpo ? { dpo: { name: generalisePlain(fiduciary.dpo.name, values), email: generalisePlain(fiduciary.dpo.email, values) } } : {}),
    rightsUrl: generalisePlain(fiduciary.rightsUrl, values),
    boardComplaintInfo: generalisePlain(fiduciary.boardComplaintInfo, values),
    ...(fiduciary.noticeUrl ? { noticeUrl: generalisePlain(fiduciary.noticeUrl, values) } : {}),
  };
  const stripped = stripOrigins({ ...def, formId: TEMPLATE_FORM_ID, behavior, privacy: { ...def.privacy, fiduciary: generalisedFiduciary } });
  const doc = generaliseRich(placeholdersIn(stripped, '/document', hits), values) as FormDefinition;
  scanTree(doc, '/document', hits);

  const refs: NonNullable<FormTemplatePayload['refs']> = {};
  const emails: EmailTemplatePayload[] = (ops?.notifications ?? []).map((n, i) => {
    const at = `/refs/emails/${i}`;
    const body = generaliseRich(stripOrigins(placeholdersIn(n.body, `${at}/body`, hits)), values) as EmailTemplatePayload['body'];
    const subject = generalisePlain(n.subject, values);
    const email: EmailTemplatePayload = {
      ...common([subject, body]),
      kind: 'email',
      role: n.kind === 'autoresponder' ? 'autoresponder' : n.trigger === 'edited' ? 'edit_notice' : 'notification',
      subject,
      body,
      ...(n.replyTo ? { replyTo: placeholder(n.replyTo, `${at}/replyTo`, hits) } : {}),
      defaultRecipients: n.to.map((r, j) => placeholder(r, `${at}/defaultRecipients/${j}`, hits)),
      includeWithdrawalLink: n.includeWithdrawalLink,
    };
    scanTree({ subject: email.subject, body: email.body }, at, hits);
    return email;
  });
  if (emails.length) refs.emails = emails;
  const pdfs: PdfTemplatePayload[] = (ops?.pdfTemplates ?? []).map((p, i) => {
    const { id: _id, name: _name, origin: _origin, ...layout } = p;
    const generalised = generaliseRich(stripOrigins(layout), values) as PdfTemplatePayload['layout'];
    const pdf: PdfTemplatePayload = { ...common(generalised), kind: 'pdf', layout: generalised };
    scanTree(pdf.layout, `/refs/pdf/${i}/layout`, hits);
    return pdf;
  });
  if (pdfs.length) refs.pdf = pdfs;
  const screens: FormOps['access']['screens'] = ops?.access.screens ?? {};
  const endings: EndingTemplatePayload[] = [];
  for (const [role, screen] of Object.entries(screens)) {
    if (!screen) continue;
    const content = generaliseRich(stripOrigins(screen.content), values) as EndingTemplatePayload['content'];
    scanTree(content, `/refs/endings/${endings.length}/content`, hits);
    endings.push({ ...common(content), kind: 'ending', role: role as StatusScreenRole, content, actions: [] });
  }
  if (endings.length) refs.endings = endings;

  const types = new Set<string>();
  let inputs = 0;
  for (const block of Object.values(doc.blocks)) {
    if (!block || block.type === 'unsupported') continue;
    types.add(block.type);
    if (INPUTS.has(block.type)) inputs += 1;
  }
  const payload: FormTemplatePayload = {
    ...common(doc),
    requiredFeatures: [...types].sort().map((t): FeatureId => `field:${t}`),
    kind: 'form',
    document: doc,
    ...(Object.keys(refs).length ? { refs } : {}),
    dataInventory: dataInventory(doc),
    estimatedMinutes: Math.max(1, Math.ceil(inputs / 4)),
  };
  const piiHits = hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { payload, piiHits, warnings: sensitiveWarning(Object.values(doc.blocks).filter((b) => b !== undefined)) };
};
