import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { buildApiRequest, defaultSuccess, getAtPath, parseApiBody } from '@form/renderer';
import {
  isSafeUrl,
  type ApiSuccessRule,
  type ApiValidation,
  type FieldBlock,
  type SafeUrl,
} from '@form/schema';
import { t } from '@/i18n';
import { applyPatch } from '@/lib/applyPatch';
import { useDraft } from '@/lib/useDraft';
import { updateBlock } from '@/state/actions';
import { Alert, AlertDescription, Badge, Button, Input, Label, ToggleGroup, ToggleGroupItem } from '@dmacq/ui';
import { ApiRequestFields } from '@/components/builder/inspector/apiRequest';
import { ApiResponseTree } from '@/components/builder/inspector/ApiResponseTree';
import { SectionTitle, TextField, ToggleRow } from '@/components/builder/inspector/parts';

const M = defineMessages('builder', {
  'inspector.api_validation': 'Validate with an API',
  'inspector.api_url_hint': 'GET sends this field’s key ({key}) as a query param. POST sends it in the JSON body.',
  'inspector.api_query_hint': 'Optional extra query values. The field answer is added automatically.',
  'inspector.api_body_hint': 'Optional extra JSON fields. The field answer is added automatically.',
  'inspector.api_remove_pair': 'Remove',
  'inspector.api_sample': 'Sample answer',
  'inspector.api_sample_hint': 'Used only to test the request. Live forms send the respondent’s answer.',
  'inspector.api_test': 'Test',
  'inspector.api_testing': 'Testing…',
  'inspector.api_test_fail': 'The request could not be sent. Check the URL and that the API allows this origin.',
  'inspector.api_parse_fail': 'The response could not be parsed as {format}.',
  'inspector.api_empty': 'The response had no keys to pick.',
  'inspector.api_pick': 'Use this key',
  'inspector.api_path_empty': 'Not chosen yet',
  'inspector.api_track': 'Pass when {key} is',
  'inspector.api_true': 'true',
  'inspector.api_false': 'false',
  'inspector.api_string_values': 'Any of these text values',
  'inspector.api_string_add': 'Add value',
  'inspector.api_string_placeholder': 'validated',
  'inspector.api_step_request': 'Request',
  'inspector.api_step_test': 'Try a sample',
  'inspector.api_step_pass': 'When it passes',
});


const DEFAULT_API: ApiValidation = { url: 'http://localhost:3001/verify-name' as SafeUrl, method: 'POST', parser: 'json' };

function patch(block: FieldBlock, next: { [K in keyof ApiValidation]?: ApiValidation[K] | undefined }): void {
  const current = block.apiValidation;
  if (!current) return;
  const merged: ApiValidation = applyPatch(current, next);
  for (const key of ['query', 'body', 'auth', 'responseKey', 'success'] as const) {
    if (merged[key] === undefined) delete merged[key];
  }
  if (merged.query && merged.query.length === 0) delete merged.query;
  if (merged.body && merged.body.length === 0) delete merged.body;
  updateBlock(block.id, { apiValidation: merged });
}

function SuccessEditor({ rule, onChange }: { rule: ApiSuccessRule; onChange: (next: ApiSuccessRule) => void }) {
  if (rule.type === 'boolean') {
    return (
      <ToggleGroup type="single" size="sm" appearance="tinted" className="w-full" value={rule.equals ? 'true' : 'false'} onValueChange={(v) => v && onChange({ type: 'boolean', equals: v === 'true' })}>
        <ToggleGroupItem value="true" className="flex-1">{t(M['inspector.api_true'])}</ToggleGroupItem>
        <ToggleGroupItem value="false" className="flex-1">{t(M['inspector.api_false'])}</ToggleGroupItem>
      </ToggleGroup>
    );
  }
  if (rule.type === 'number') {
    return (
      <Input
        inputMode="decimal"
        aria-label={t(M['inspector.api_track'], { key: 'number' })}
        value={String(rule.equals)}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange({ type: 'number', equals: n });
        }}
      />
    );
  }
  const values = rule.equals.slice(0, 3);
  return (
    <div className="space-y-2">
      {values.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={`${t(M['inspector.api_string_values'])} ${i + 1}`}
            value={value}
            placeholder={t(M['inspector.api_string_placeholder'])}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              const equals = next.map((s) => s.trim()).filter(Boolean).slice(0, 3);
              if (equals.length) onChange({ type: 'string', equals });
            }}
          />
          {values.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t(M['inspector.api_remove_pair'])}
              onClick={() => {
                const equals = values.filter((_, j) => j !== i);
                if (equals.length) onChange({ type: 'string', equals });
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
      {values.length < 3 ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ type: 'string', equals: [...values.filter((v) => v.trim()), 'validated'] })}>
          <Plus className="size-3.5" />
          {t(M['inspector.api_string_add'])}
        </Button>
      ) : null}
    </div>
  );
}

export function ApiValidationSection({ block }: { block: FieldBlock }) {
  const api = block.apiValidation;
  const storedUrl = api?.url ?? '';
  const [urlText, setUrlText] = useDraft(storedUrl);
  const [sample, setSample] = useState('');
  const [status, setStatus] = useState<'idle' | 'testing' | 'fail' | 'parse' | 'empty' | 'ok'>('idle');
  const [data, setData] = useState<unknown>();

  const on = api !== undefined;

  const test = async () => {
    if (!api || !isSafeUrl(api.url)) return;
    setStatus('testing');
    setData(undefined);
    try {
      const { url, init } = buildApiRequest(api, block.key, sample);
      const res = await fetch(url, init);
      const text = await res.text();
      const parsed = parseApiBody(text, api.parser ?? 'json');
      if (parsed.data === undefined) {
        setStatus(text.trim() ? 'parse' : 'empty');
        return;
      }
      setData(parsed.data);
      setStatus('ok');
    } catch {
      setStatus('fail');
    }
  };

  const pick = (path: string) => {
    if (!api || data === undefined || !path) return;
    const value = getAtPath(data, path);
    if (typeof value === 'boolean') patch(block, { responseKey: path, success: defaultSuccess({ key: path, type: 'boolean', value }) });
    else if (typeof value === 'number') patch(block, { responseKey: path, success: defaultSuccess({ key: path, type: 'number', value }) });
    else if (typeof value === 'string') patch(block, { responseKey: path, success: defaultSuccess({ key: path, type: 'string', value }) });
  };

  return (
    <>
      <ToggleRow
        label={t(M['inspector.api_validation'])}
        checked={on}
        onChange={(enabled) => {
          setData(undefined);
          setStatus('idle');
          updateBlock(block.id, { apiValidation: enabled ? { ...DEFAULT_API } : undefined });
        }}
      />
      {api ? (
        <div className="space-y-4">
          <SectionTitle>{t(M['inspector.api_step_request'])}</SectionTitle>
          <ApiRequestFields
            api={api}
            urlHint={t(M['inspector.api_url_hint'], { key: block.key })}
            queryHint={t(M['inspector.api_query_hint'])}
            bodyHint={t(M['inspector.api_body_hint'])}
            urlText={urlText}
            onUrlText={setUrlText}
            onPatch={(next) => patch(block, next)}
          />
          <SectionTitle>{t(M['inspector.api_step_test'])}</SectionTitle>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                label={t(M['inspector.api_sample'])}
                hint={t(M['inspector.api_sample_hint'])}
                value={sample}
                onChange={setSample}
                placeholder={block.key}
              />
            </div>
            <Button type="button" size="sm" disabled={status === 'testing' || !sample.trim()} onClick={() => void test()}>
              {status === 'testing' ? t(M['inspector.api_testing']) : t(M['inspector.api_test'])}
            </Button>
          </div>
          {status === 'fail' ? <Alert variant="negative" emphasis="subtle"><AlertDescription>{t(M['inspector.api_test_fail'])}</AlertDescription></Alert> : null}
          {status === 'parse' ? <Alert variant="warning" emphasis="subtle"><AlertDescription>{t(M['inspector.api_parse_fail'], { format: (api.parser ?? 'json').toUpperCase() })}</AlertDescription></Alert> : null}
          {status === 'empty' ? <Alert variant="info" emphasis="subtle"><AlertDescription>{t(M['inspector.api_empty'])}</AlertDescription></Alert> : null}
          {status === 'ok' && data !== undefined ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>{t(M['inspector.api_pick'])}</Label>
                {api.responseKey ? (
                  <Badge variant="secondary" className="max-w-[60%] truncate font-mono">response.{api.responseKey}</Badge>
                ) : (
                  <span className="text-[12px] text-muted-foreground">{t(M['inspector.api_path_empty'])}</span>
                )}
              </div>
              <ApiResponseTree data={data} mode="check" selected={api.responseKey} onSelect={(path) => pick(path)} />
            </div>
          ) : null}
          {api.responseKey && api.success ? (
            <>
              <SectionTitle>{t(M['inspector.api_step_pass'])}</SectionTitle>
              <div className="space-y-2">
                <Label>{t(M['inspector.api_track'], { key: api.responseKey })}</Label>
                <SuccessEditor rule={api.success} onChange={(success) => patch(block, { success })} />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
