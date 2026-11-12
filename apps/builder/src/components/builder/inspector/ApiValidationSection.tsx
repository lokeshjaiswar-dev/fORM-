import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { buildApiRequest, defaultSuccess, parseApiBody, type ApiResponseLeaf } from '@form/renderer';
import {
  isSafeUrl,
  type ApiAuth,
  type ApiPair,
  type ApiSuccessRule,
  type ApiValidation,
  type FieldBlock,
  type SafeUrl,
} from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { updateBlock } from '@/state/actions';
import { Button, Input, ToggleGroup, ToggleGroupItem } from '@dmacq/ui';
import { Field, SelectField, TextField, ToggleRow } from '@/components/builder/inspector/parts';

const M = defineMessages('builder', {
  'inspector.api_validation': 'Validate with an API',
  'inspector.api_url': 'API URL',
  'inspector.api_url_hint': 'GET sends this field’s key ({key}) as a query param. POST sends it in the JSON body.',
  'inspector.api_method': 'Request',
  'inspector.api_get': 'GET',
  'inspector.api_post': 'POST',
  'inspector.api_query': 'Query params',
  'inspector.api_query_hint': 'Optional extra query values. The field answer is added automatically.',
  'inspector.api_body': 'Extra body fields',
  'inspector.api_body_hint': 'Optional extra JSON fields. The field answer is added automatically.',
  'inspector.api_pair_key': 'Name',
  'inspector.api_pair_value': 'Value',
  'inspector.api_add_param': 'Add param',
  'inspector.api_add_body': 'Add field',
  'inspector.api_remove_pair': 'Remove',
  'inspector.api_auth': 'Authorization',
  'inspector.api_auth_none': 'None',
  'inspector.api_auth_bearer': 'Bearer token',
  'inspector.api_auth_key': 'API key',
  'inspector.api_auth_basic': 'Username and password',
  'inspector.api_token': 'Token',
  'inspector.api_header': 'Header name',
  'inspector.api_header_value': 'Key',
  'inspector.api_username': 'Username',
  'inspector.api_password': 'Password',
  'inspector.api_sample': 'Sample answer',
  'inspector.api_sample_hint': 'Used only to test the request. Live forms send the respondent’s answer.',
  'inspector.api_test': 'Test',
  'inspector.api_testing': 'Testing…',
  'inspector.api_parser': 'Response format',
  'inspector.api_json': 'JSON',
  'inspector.api_xml': 'XML',
  'inspector.api_test_fail': 'The request could not be sent. Check the URL and that the API allows this origin.',
  'inspector.api_parse_fail': 'The response could not be parsed as {format}.',
  'inspector.api_empty': 'The response had no keys to pick.',
  'inspector.api_col_key': 'Key',
  'inspector.api_col_type': 'Type',
  'inspector.api_col_value': 'Value',
  'inspector.api_pick': 'Use this key',
  'inspector.api_track': 'Pass when {key} is',
  'inspector.api_true': 'true',
  'inspector.api_false': 'false',
  'inspector.api_string_values': 'Any of these text values',
  'inspector.api_string_add': 'Add value',
  'inspector.api_string_placeholder': 'validated',
});

const DEFAULT_API: ApiValidation = { url: 'http://localhost:3001/verify-name' as SafeUrl, method: 'POST', parser: 'json' };

function patch(block: FieldBlock, next: Partial<ApiValidation>): void {
  const current = block.apiValidation;
  if (!current) return;
  const merged: ApiValidation = { ...current, ...next };
  for (const key of ['query', 'body', 'auth', 'responseKey', 'success'] as const) {
    if (merged[key] === undefined) delete merged[key];
  }
  if (merged.query && merged.query.length === 0) delete merged.query;
  if (merged.body && merged.body.length === 0) delete merged.body;
  updateBlock(block.id, { apiValidation: merged });
}

function nextName(existing: ApiPair[], prefix: string): string {
  const used = new Set(existing.map((p) => p.key));
  let n = 1;
  while (used.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

function PairList({
  pairs,
  addLabel,
  onChange,
}: {
  pairs: ApiPair[];
  addLabel: string;
  onChange: (next: ApiPair[]) => void;
}) {
  return (
    <div className="space-y-2">
      {pairs.map((pair, i) => (
        <div key={`${i}-${pair.key}`} className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              aria-label={t(M['inspector.api_pair_key'])}
              value={pair.key}
              placeholder={t(M['inspector.api_pair_key'])}
              onChange={(e) => {
                const key = e.target.value.slice(0, 64);
                onChange(pairs.map((p, j) => (j === i ? { ...p, key } : p)).filter((p) => p.key.trim() !== '' || p.value !== ''));
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Input
              aria-label={`${t(M['inspector.api_pair_value'])} ${pair.key}`}
              value={pair.value}
              placeholder={t(M['inspector.api_pair_value'])}
              onChange={(e) => onChange(pairs.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))}
            />
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['inspector.api_remove_pair'])} onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...pairs, { key: nextName(pairs, 'param'), value: '' }])}>
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

function authKind(auth: ApiAuth | undefined): 'none' | ApiAuth['type'] {
  return auth?.type ?? 'none';
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
  const [leaves, setLeaves] = useState<ApiResponseLeaf[]>([]);

  const on = api !== undefined;

  const test = async () => {
    if (!api || !isSafeUrl(api.url)) return;
    setStatus('testing');
    setLeaves([]);
    try {
      const { url, init } = buildApiRequest(api, block.key, sample);
      const res = await fetch(url, init);
      const text = await res.text();
      const parsed = parseApiBody(text, api.parser ?? 'json');
      if (!parsed.leaves.length) {
        setStatus(text.trim() ? 'parse' : 'empty');
        return;
      }
      setLeaves(parsed.leaves);
      setStatus('ok');
    } catch {
      setStatus('fail');
    }
  };

  const pick = (leaf: ApiResponseLeaf) => {
    if (!api) return;
    patch(block, { responseKey: leaf.key, success: defaultSuccess(leaf) });
  };

  return (
    <>
      <ToggleRow
        label={t(M['inspector.api_validation'])}
        checked={on}
        onChange={(enabled) => {
          setLeaves([]);
          setStatus('idle');
          updateBlock(block.id, { apiValidation: enabled ? { ...DEFAULT_API } : undefined });
        }}
      />
      {api ? (
        <div className="space-y-4">
          <Field label={t(M['inspector.api_method'])}>
            <ToggleGroup
              type="single"
              size="sm"
              appearance="tinted"
              className="w-full"
              aria-label={t(M['inspector.api_method'])}
              value={api.method ?? 'POST'}
              onValueChange={(method) => method && patch(block, { method: method as 'GET' | 'POST' })}
            >
              <ToggleGroupItem value="GET" className="flex-1">{t(M['inspector.api_get'])}</ToggleGroupItem>
              <ToggleGroupItem value="POST" className="flex-1">{t(M['inspector.api_post'])}</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <TextField
            label={t(M['inspector.api_url'])}
            hint={t(M['inspector.api_url_hint'], { key: block.key })}
            value={urlText}
            placeholder="https://api.example.com/verify"
            onChange={(url) => {
              setUrlText(url);
              if (isSafeUrl(url)) patch(block, { url: url as SafeUrl });
            }}
          />
          <div className="space-y-1.5">
            <p className="text-[13px] font-medium">{t(M['inspector.api_query'])}</p>
            <p className="text-[12px] text-muted-foreground">{t(M['inspector.api_query_hint'])}</p>
            <PairList pairs={api.query ?? []} addLabel={t(M['inspector.api_add_param'])} onChange={(query) => patch(block, { query })} />
          </div>
          {(api.method ?? 'POST') === 'POST' ? (
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium">{t(M['inspector.api_body'])}</p>
              <p className="text-[12px] text-muted-foreground">{t(M['inspector.api_body_hint'])}</p>
              <PairList pairs={api.body ?? []} addLabel={t(M['inspector.api_add_body'])} onChange={(body) => patch(block, { body })} />
            </div>
          ) : null}
          <SelectField
            label={t(M['inspector.api_auth'])}
            value={authKind(api.auth)}
            options={[
              { value: 'none', label: t(M['inspector.api_auth_none']) },
              { value: 'bearer', label: t(M['inspector.api_auth_bearer']) },
              { value: 'api_key', label: t(M['inspector.api_auth_key']) },
              { value: 'basic', label: t(M['inspector.api_auth_basic']) },
            ]}
            onChange={(kind) => {
              if (kind === 'none') patch(block, { auth: undefined });
              else if (kind === 'bearer') patch(block, { auth: { type: 'bearer', token: api.auth?.type === 'bearer' ? api.auth.token : 'token' } });
              else if (kind === 'api_key') patch(block, { auth: { type: 'api_key', header: 'X-API-Key', value: 'key' } });
              else patch(block, { auth: { type: 'basic', username: 'user', password: '' } });
            }}
          />
          {api.auth?.type === 'bearer' ? (
            <TextField label={t(M['inspector.api_token'])} value={api.auth.token} onChange={(token) => token && patch(block, { auth: { type: 'bearer', token } })} />
          ) : null}
          {api.auth?.type === 'api_key' ? (
            <>
              <TextField
                label={t(M['inspector.api_header'])}
                value={api.auth.header}
                onChange={(header) => {
                  if (header && api.auth?.type === 'api_key') patch(block, { auth: { type: 'api_key', header, value: api.auth.value } });
                }}
              />
              <TextField
                label={t(M['inspector.api_header_value'])}
                value={api.auth.value}
                onChange={(value) => {
                  if (value && api.auth?.type === 'api_key') patch(block, { auth: { type: 'api_key', header: api.auth.header, value } });
                }}
              />
            </>
          ) : null}
          {api.auth?.type === 'basic' ? (
            <>
              <TextField
                label={t(M['inspector.api_username'])}
                value={api.auth.username}
                onChange={(username) => {
                  if (username && api.auth?.type === 'basic') patch(block, { auth: { type: 'basic', username, password: api.auth.password } });
                }}
              />
              <TextField
                label={t(M['inspector.api_password'])}
                value={api.auth.password}
                onChange={(password) => {
                  if (api.auth?.type === 'basic') patch(block, { auth: { type: 'basic', username: api.auth.username, password } });
                }}
              />
            </>
          ) : null}
          <Field label={t(M['inspector.api_parser'])}>
            <ToggleGroup
              type="single"
              size="sm"
              appearance="tinted"
              className="w-full"
              aria-label={t(M['inspector.api_parser'])}
              value={api.parser ?? 'json'}
              onValueChange={(parser) => parser && patch(block, { parser: parser as 'json' | 'xml' })}
            >
              <ToggleGroupItem value="json" className="flex-1">{t(M['inspector.api_json'])}</ToggleGroupItem>
              <ToggleGroupItem value="xml" className="flex-1">{t(M['inspector.api_xml'])}</ToggleGroupItem>
            </ToggleGroup>
          </Field>
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
          {status === 'fail' ? <p role="alert" className="text-[12px] text-amber-700">{t(M['inspector.api_test_fail'])}</p> : null}
          {status === 'parse' ? <p role="alert" className="text-[12px] text-amber-700">{t(M['inspector.api_parse_fail'], { format: (api.parser ?? 'json').toUpperCase() })}</p> : null}
          {status === 'empty' ? <p className="text-[12px] text-muted-foreground">{t(M['inspector.api_empty'])}</p> : null}
          {leaves.length ? (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full table-fixed text-left text-[12px]">
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[28%]" />
                  <col className="w-[32%]" />
                </colgroup>
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">{t(M['inspector.api_col_key'])}</th>
                    <th className="px-2 py-1.5 font-medium">{t(M['inspector.api_col_type'])}</th>
                    <th className="px-2 py-1.5 font-medium">{t(M['inspector.api_col_value'])}</th>
                  </tr>
                </thead>
                <tbody>
                  {leaves.map((leaf) => {
                    const selected = api.responseKey === leaf.key;
                    return (
                      <tr
                        key={leaf.key}
                        className={`cursor-pointer ${selected ? 'bg-state-hover' : 'hover:bg-muted/40'}`}
                        aria-selected={selected}
                        onClick={() => pick(leaf)}
                      >
                        <td className="truncate px-2 py-1.5 font-mono">
                          <button type="button" className="truncate text-left" aria-label={`${t(M['inspector.api_pick'])} ${leaf.key}`}>
                            {leaf.key}
                          </button>
                        </td>
                        <td className="truncate px-2 py-1.5 text-muted-foreground">{leaf.type}</td>
                        <td className="truncate px-2 py-1.5">{String(leaf.value)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {api.responseKey && api.success ? (
            <div className="space-y-2">
              <p className="text-[13px] font-medium">{t(M['inspector.api_track'], { key: api.responseKey })}</p>
              <SuccessEditor rule={api.success} onChange={(success) => patch(block, { success })} />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
