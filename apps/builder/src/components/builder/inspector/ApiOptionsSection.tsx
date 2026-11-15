import { useState } from 'react';
import { defineMessages } from '@form/i18n';
import { buildApiRequest, displayOptionPath, getAtPath, guessMapping, mapApiOptions, parseApiBody, pickFromTree } from '@form/renderer/author';
import {
  isSafeUrl,
  type ApiOptions,
  type BlockOf,
  type ChoiceOption,
  type FieldBlock,
  type SafeUrl,
} from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { patchBlockConfig } from '@/fields/configSink';
import { useDraft } from '@/lib/useDraft';
import { applyPatch, type Patch } from '@/lib/patch';
import { updateBlock } from '@/state/actions';
import { Button } from '@dmacq/ui';
import { ApiRequestFields } from '@/components/builder/inspector/apiRequest';
import { ApiResponseTree, type TreePart } from '@/components/builder/inspector/ApiResponseTree';
import { ToggleRow } from '@/components/builder/inspector/parts';

const M = defineMessages('builder', {
  'inspector.api_options': 'Load options from an API',
  'inspector.api_options_hint': 'The live form fetches this list. Static options below are the fallback.',
  'inspector.api_url_hint_options': 'GET or POST this URL. The field answer is not sent.',
  'inspector.api_query_hint_options': 'Optional extra query values.',
  'inspector.api_body_hint_options': 'Optional extra JSON fields.',
  'inspector.api_test': 'Test',
  'inspector.api_testing': 'Testing…',
  'inspector.api_test_fail': 'The request could not be sent. Check the URL and that the API allows this origin.',
  'inspector.api_parse_fail': 'The response could not be parsed as {format}.',
  'inspector.api_empty': 'The response had no keys to pick.',
  'inspector.api_label_key': 'Option text',
  'inspector.api_value_key': 'Saved value',
  'inspector.api_path_empty': 'Not chosen yet',
  'inspector.api_preview': 'Preview',
  'inspector.api_preview_label': 'Label',
  'inspector.api_preview_value': 'Value',
});

const DEFAULT_API: ApiOptions = { url: 'http://localhost:3001/cities' as SafeUrl, method: 'GET', parser: 'json' };

type ChoiceBlock = BlockOf<'single_choice' | 'multi_choice' | 'ranking' | 'matching' | 'constant_sum' | 'maxdiff'>;

function patch(block: FieldBlock, next: Patch<ApiOptions>): void {
  const current = block.apiOptions;
  if (!current) return;
  const merged = applyPatch(current, next);
  if (merged.query && merged.query.length === 0) delete merged.query;
  if (merged.body && merged.body.length === 0) delete merged.body;
  updateBlock(block.id, { apiOptions: merged });
}

function PathChip({ label, path }: { label: string; path: string | undefined }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-[12px] font-medium">{label}</p>
      <p className="truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px]">{path ?? t(M['inspector.api_path_empty'])}</p>
    </div>
  );
}

export function ApiOptionsSection({ block }: { block: ChoiceBlock }) {
  const api = block.apiOptions;
  const storedUrl = api?.url ?? '';
  const [urlText, setUrlText] = useDraft(storedUrl);
  const [status, setStatus] = useState<'idle' | 'testing' | 'fail' | 'parse' | 'empty' | 'ok'>('idle');
  const [data, setData] = useState<unknown>();
  const [picked, setPicked] = useState<{ path: string; part: TreePart }>();

  const on = api !== undefined;
  const preview = api && data !== undefined && api.itemsPath !== undefined ? mapApiOptions(data, api) : [];
  const labelPath = api?.itemsPath !== undefined ? displayOptionPath(api.itemsPath, api.labelKey ?? '$self') : undefined;
  const valuePath = api?.itemsPath !== undefined ? displayOptionPath(api.itemsPath, api.valueKey ?? '$self') : undefined;

  const applyOptions = (next: ChoiceOption[]) => {
    if (next.length) patchBlockConfig(block, { options: next });
  };

  const applyPick = (role: 'label' | 'value' | 'both', path: string, part: TreePart) => {
    if (!api || data === undefined) return;
    const mapped = pickFromTree(data, path, part);
    if (!mapped) return;
    let field = mapped.field;
    let valueField = mapped.collectionKind === 'map' ? '$key' : mapped.field;
    if (role === 'both' && mapped.collectionKind === 'array') {
      const at = mapped.itemsPath === '' ? data : getAtPath(data, mapped.itemsPath);
      const sample = Array.isArray(at) ? at.find((row) => row && typeof row === 'object' && !Array.isArray(row)) : undefined;
      if (sample && typeof sample === 'object') {
        const guessed = guessMapping('array', false, Object.keys(sample as object));
        if (guessed.labelKey) field = guessed.labelKey;
        if (guessed.valueKey) valueField = guessed.valueKey;
      }
    }
    const next: ApiOptions = {
      ...api,
      itemsPath: mapped.itemsPath,
      collectionKind: mapped.collectionKind,
      labelKey: role === 'value' ? api.labelKey ?? field : field,
      valueKey: role === 'label' ? api.valueKey ?? field : role === 'both' ? valueField : field,
    };
    patch(block, { itemsPath: next.itemsPath, collectionKind: next.collectionKind, labelKey: next.labelKey, valueKey: next.valueKey });
    applyOptions(mapApiOptions(data, next));
  };

  const test = async () => {
    if (!api || !isSafeUrl(api.url)) return;
    setStatus('testing');
    setData(undefined);
    setPicked(undefined);
    try {
      const { url, init } = buildApiRequest(api);
      const res = await fetch(url, init);
      const text = await res.text();
      const parsed = parseApiBody(text, api.parser ?? 'json');
      if (parsed.data === undefined) {
        setStatus(text.trim() ? 'parse' : 'empty');
        return;
      }
      setData(parsed.data);
      setStatus('ok');
      if (api.itemsPath !== undefined) applyOptions(mapApiOptions(parsed.data, api));
    } catch {
      setStatus('fail');
    }
  };

  return (
    <div className="space-y-4">
      <ToggleRow
        label={t(M['inspector.api_options'])}
        hint={t(M['inspector.api_options_hint'])}
        checked={on}
        onChange={(enabled) => {
          setData(undefined);
          setPicked(undefined);
          setStatus('idle');
          updateBlock(block.id, { apiOptions: enabled ? { ...DEFAULT_API } : undefined });
        }}
      />
      {api ? (
        <>
          <ApiRequestFields
            api={api}
            urlHint={t(M['inspector.api_url_hint_options'])}
            queryHint={t(M['inspector.api_query_hint_options'])}
            bodyHint={t(M['inspector.api_body_hint_options'])}
            urlText={urlText}
            onUrlText={setUrlText}
            onPatch={(next) => patch(block, next)}
          />
          <Button type="button" size="sm" disabled={status === 'testing'} onClick={() => void test()}>
            {status === 'testing' ? t(M['inspector.api_testing']) : t(M['inspector.api_test'])}
          </Button>
          {status === 'fail' ? <p role="alert" className="text-[12px] text-amber-700">{t(M['inspector.api_test_fail'])}</p> : null}
          {status === 'parse' ? <p role="alert" className="text-[12px] text-amber-700">{t(M['inspector.api_parse_fail'], { format: (api.parser ?? 'json').toUpperCase() })}</p> : null}
          {status === 'empty' ? <p className="text-[12px] text-muted-foreground">{t(M['inspector.api_empty'])}</p> : null}
          {status === 'ok' && data !== undefined ? (
            <>
              <div className="grid grid-cols-1 gap-2">
                <PathChip label={t(M['inspector.api_label_key'])} path={labelPath} />
                <PathChip label={t(M['inspector.api_value_key'])} path={valuePath} />
              </div>
              <ApiResponseTree
                data={data}
                mode="options"
                selected={picked?.path}
                onSelect={(path, part) => {
                  setPicked({ path, part });
                  if (part === 'list') applyPick('both', path, part);
                }}
                onUse={(role) => {
                  if (picked) applyPick(role, picked.path, picked.part);
                }}
              />
            </>
          ) : null}
          {preview.length ? (
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium">{t(M['inspector.api_preview'])}</p>
              <div className="overflow-hidden rounded-md border">
                <table className="w-full table-fixed text-left text-[12px]">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">{t(M['inspector.api_preview_label'])}</th>
                      <th className="px-2 py-1.5 font-medium">{t(M['inspector.api_preview_value'])}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.slice(0, 20).map((opt) => (
                      <tr key={opt.id}>
                        <td className="truncate px-2 py-1.5">{labelString(opt.label)}</td>
                        <td className="truncate px-2 py-1.5 font-mono">{opt.id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
