import { useState } from 'react';
import { defineMessages } from '@form/i18n';
import { buildApiRequest, displayOptionPath, getAtPath, guessMapping, mapApiOptions, parseApiBody, pickFromTree } from '@form/renderer';
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
import { applyPatch } from '@/lib/applyPatch';
import { useDraft } from '@/lib/useDraft';
import { updateBlock } from '@/state/actions';
import { Alert, AlertDescription, Badge, Button, Label, Separator, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dmacq/ui';
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

function patch(block: FieldBlock, next: { [K in keyof ApiOptions]?: ApiOptions[K] | undefined }): void {
  const current = block.apiOptions;
  if (!current) return;
  const merged: ApiOptions = applyPatch(current, next);
  for (const key of ['query', 'body', 'auth', 'itemsPath', 'collectionKind', 'labelKey', 'valueKey'] as const) {
    if (merged[key] === undefined) delete merged[key];
  }
  if (merged.query && merged.query.length === 0) delete merged.query;
  if (merged.body && merged.body.length === 0) delete merged.body;
  updateBlock(block.id, { apiOptions: merged });
}

function PathChip({ label, path }: { label: string; path: string | undefined }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <Label>{label}</Label>
      {path ? (
        <Badge variant="secondary" className="max-w-[60%] truncate font-mono">{path}</Badge>
      ) : (
        <span className="text-[12px] text-muted-foreground">{t(M['inspector.api_path_empty'])}</span>
      )}
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
          {status === 'fail' ? <Alert variant="negative" emphasis="subtle"><AlertDescription>{t(M['inspector.api_test_fail'])}</AlertDescription></Alert> : null}
          {status === 'parse' ? <Alert variant="warning" emphasis="subtle"><AlertDescription>{t(M['inspector.api_parse_fail'], { format: (api.parser ?? 'json').toUpperCase() })}</AlertDescription></Alert> : null}
          {status === 'empty' ? <Alert variant="info" emphasis="subtle"><AlertDescription>{t(M['inspector.api_empty'])}</AlertDescription></Alert> : null}
          {status === 'ok' && data !== undefined ? (
            <>
              <Separator />
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
              <Label>{t(M['inspector.api_preview'])}</Label>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t(M['inspector.api_preview_label'])}</TableHead>
                    <TableHead>{t(M['inspector.api_preview_value'])}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.slice(0, 20).map((opt) => (
                    <TableRow key={opt.id}>
                      <TableCell className="truncate">{labelString(opt.label)}</TableCell>
                      <TableCell className="truncate font-mono">{opt.id}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
