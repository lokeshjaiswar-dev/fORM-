import { applyMapping, CONTENT_TYPES, renderJson, renderXml, validateMapping, type WebhookPayloadMapping } from '@form/schema';
import type { BuiltWebhookPayload } from './payload.ts';

/*
 * The bytes of a webhook request, from the standard payload `buildWebhookPayload` made. That payload is already filtered by
 * `disclosableFields` (purposes, omit, mask, taint), and a mapping only ever reads from it: a field that is not in it
 * cannot be named by a mapping, and a masked one stays `MASK`. The signature is computed over the string returned here and the
 * request sends that same string with `contentType`, so the two cannot differ.
 *
 *   no mapping, json   the standard payload, byte for byte what it was before mappings existed
 *   no mapping, xml    the standard payload as XML, root <webhook>
 *   mapping            only the mapped values, in the shape the paths describe (root <submission> in XML by default)
 */

/** The largest body of a custom (mapped or XML) delivery. The standard JSON body is not capped here, as before. */
export const MAX_CUSTOM_BODY_BYTES = 1024 * 1024;

export interface RenderedBody {
  body: string;
  contentType: string;
  /** The field keys whose value is in the body (a mapped body may carry fewer than the payload had). */
  sentKeys: string[];
}

export class BodyRefused extends Error {}

export function renderWebhookBody(built: BuiltWebhookPayload, cfg: { bodyFormat: 'json' | 'xml'; payloadMapping: WebhookPayloadMapping | null }): RenderedBody {
  const { payload } = built;
  if (cfg.payloadMapping === null || cfg.payloadMapping === undefined) {
    if (cfg.bodyFormat === 'json') return { body: JSON.stringify(payload), contentType: CONTENT_TYPES.json, sentKeys: built.sentKeys };
    return finish(renderXml('webhook', payload), CONTENT_TYPES.xml, built.sentKeys);
  }
  const issues = validateMapping(cfg.payloadMapping);
  if (issues.length > 0) throw new BodyRefused(`the payload mapping is not valid (${issues[0]})`);
  const { tree, usedKeys } = applyMapping(cfg.payloadMapping, {
    answers: built.byKey,
    meta: {
      event: payload.event,
      eventId: payload.id,
      createdAt: payload.createdAt,
      formId: payload.form.id,
      submissionId: payload.submission.id,
      submittedAt: payload.submission.submittedAt,
    },
  });
  const used = new Set(usedKeys);
  const sentKeys = built.sentKeys.filter((k) => used.has(k));
  return cfg.bodyFormat === 'json'
    ? finish(renderJson(tree), CONTENT_TYPES.json, sentKeys)
    : finish(renderXml(cfg.payloadMapping.root ?? 'submission', tree), CONTENT_TYPES.xml, sentKeys);
}

function finish(body: string, contentType: string, sentKeys: string[]): RenderedBody {
  if (Buffer.byteLength(body, 'utf8') > MAX_CUSTOM_BODY_BYTES) throw new BodyRefused('the body is larger than 1 MiB');
  return { body, contentType, sentKeys };
}
