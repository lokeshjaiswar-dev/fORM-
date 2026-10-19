import { valueDefinition } from '@form/registry';
import type { AnswerValue, Answers, EvalMeta, FieldBlock, LabelText, PipeAttrs, PlainTemplate, PublicFormDefinition, StoredBlock, ValueFieldType } from '@form/schema';

/*
 * Piping (PRE-02) in the respondent UI: an answer pipe shows the answer's export text, a meta pipe the session value;
 * hidden, empty and unsupported sources show the pipe's fallback. Template variables are resolved at publish (I11),
 * so a `var` left in a runtime version shows its fallback too.
 */

export interface PipeContext {
  def: PublicFormDefinition;
  /** `EvalState.values`: only visible, enabled, on-path answers. */
  values: Answers;
  meta: Pick<EvalMeta, 'locale' | 'timeZone' | 'urlParams' | 'device' | 'pageUrl' | 'referrer' | 'embedOrigin' | 'isPreview'>;
}

const isField = (block: StoredBlock | undefined): block is FieldBlock => block !== undefined && block.type !== 'unsupported' && 'key' in block;

function answerText(block: FieldBlock, answer: AnswerValue): string {
  try {
    return (valueDefinition(block.type as ValueFieldType).export.text as (value: unknown, block: unknown) => string)(answer.value, block);
  } catch {
    return '';
  }
}

function rawPipeValue(source: PipeAttrs['source'], ctx: PipeContext): string | undefined {
  let out: string | undefined;
  if (source.kind === 'answer') {
    const block = ctx.def.blocks[source.blockId];
    const answer = ctx.values[source.blockId];
    if (isField(block) && answer && source.path === undefined) out = answerText(block, answer);
  } else if (source.kind === 'meta') {
    const m = ctx.meta;
    switch (source.key) {
      case 'url_param':
        out = source.name === undefined ? undefined : m.urlParams[source.name];
        break;
      case 'utm_source':
      case 'utm_medium':
      case 'utm_campaign':
      case 'utm_term':
      case 'utm_content':
        out = m.urlParams[source.key];
        break;
      case 'locale':
        out = m.locale;
        break;
      case 'time_zone':
        out = m.timeZone;
        break;
      case 'device':
        out = m.device;
        break;
      case 'page_url':
        out = m.pageUrl;
        break;
      case 'referrer':
        out = m.referrer;
        break;
      case 'embed_origin':
        out = m.embedOrigin;
        break;
      default:
        out = undefined;
    }
  }
  return out;
}

export function pipeValue(attrs: PipeAttrs, ctx: PipeContext): string | undefined {
  let out = rawPipeValue(attrs.source, ctx);
  if (out !== undefined && attrs.encode === 'url') out = encodeURIComponent(out);
  return out || undefined;
}

/** A plain template as text: literal parts as written, pipes resolved, variables by their fallback. */
export function templateText(template: PlainTemplate, ctx: PipeContext): string {
  return template.map((part) => {
    if (typeof part === 'string') return part;
    if ('pipe' in part) return pipeValue(part.pipe, ctx) ?? part.pipe.fallback ?? '';
    return part.var.fallback ?? '';
  }).join('');
}

/**
 * A URL template (redirect endings, visit_url actions) as text: every piped value and fallback is percent-encoded,
 * whatever the pipe's `encode`, so an answer can never add a query, fragment or path part (schema §END, S6).
 */
export function urlText(template: PlainTemplate, ctx: PipeContext): string {
  return template.map((part) => {
    if (typeof part === 'string') return part;
    const value = 'pipe' in part ? rawPipeValue(part.pipe.source, ctx) || part.pipe.fallback : part.var.fallback;
    return encodeURIComponent(value ?? '');
  }).join('');
}

export const labelText = (label: LabelText | undefined, ctx: PipeContext): string =>
  label === undefined ? '' : typeof label === 'string' ? label : templateText(label, ctx);
