import { evaluateCheck, mapApiOptions, projectLookupRows } from '@form/logic';
import type { ApiLookup, ApiOptions, ApiValidation, ChoiceOption, FormDefinition } from '@form/schema';
import type { RemoteSource } from '@form/renderer';
import { testRemote, type RemoteTestRequest } from '@/persistence/remoteApi';

/*
 * The builder preview's source. The projected preview form holds only markers (no URL, no keys), so the author's own draft
 * supplies the configuration here, and the call goes through the author route (`POST /v1/forms/:formId/remote/test`: the
 * server's egress guard and the org's credential, never the browser). The route returns the parsed answer, which is then
 * mapped to rows, options and a pass/fail with the same pure helpers the respondent's proxy uses on the server.
 */
export function previewRemoteSource(org: string, definition: FormDefinition): RemoteSource {
  const lookups = (): ApiLookup[] => {
    const list = (definition.lookups ?? []) as ApiLookup[];
    const legacy = definition.lookup && !list.some((l) => l.id === 'lookup') ? [{ ...definition.lookup, id: definition.lookup.id ?? 'lookup' }] : [];
    return [...list, ...legacy];
  };
  const hasBlock = (id: string) => Object.hasOwn(definition.blocks, id);
  const field = (blockId: string) => {
    const block = (definition.blocks as Record<string, unknown>)[blockId] as { key?: string; apiOptions?: ApiOptions; apiValidation?: ApiValidation } | undefined;
    return block;
  };

  return {
    async lookup(lookupId, q, signal) {
      const found = lookups().find((l) => l.id === lookupId && l.source !== 'dms_master' && l.enabled === true);
      if (!found || found.source === 'dms_master') return { rows: [], truncated: false };
      const { data } = await testRemote(org, definition.formId, found as RemoteTestRequest, found.searchParam !== undefined ? { q } : {});
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return projectLookupRows(data, found, { q, hasBlock });
    },
    async options(blockId, signal): Promise<ChoiceOption[]> {
      const api = field(blockId)?.apiOptions;
      if (!api) return [];
      const { data } = await testRemote(org, definition.formId, api as RemoteTestRequest);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return mapApiOptions(data, api).slice(0, 500);
    },
    async check(blockId, value, signal) {
      const block = field(blockId);
      const api = block?.apiValidation;
      if (!api || !block?.key) return { ok: true };
      const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : String(value ?? '');
      const { data } = await testRemote(org, definition.formId, api as RemoteTestRequest, { fieldKey: block.key, value: scalar });
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { ok: evaluateCheck(data, api) };
    },
  };
}
