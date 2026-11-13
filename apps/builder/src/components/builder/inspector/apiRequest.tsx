import { Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { isSafeUrl, type ApiAuth, type ApiPair, type ApiRequestConfig, type SafeUrl } from '@form/schema';
import { t } from '@/i18n';
import { Button, Input, ToggleGroup, ToggleGroupItem } from '@dmacq/ui';
import { Field, SelectField, TextField } from '@/components/builder/inspector/parts';

const M = defineMessages('builder', {
  'inspector.api_url': 'API URL',
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
  'inspector.api_parser': 'Response format',
  'inspector.api_json': 'JSON',
  'inspector.api_xml': 'XML',
});

export function nextPairName(existing: ApiPair[], prefix: string): string {
  const used = new Set(existing.map((p) => p.key));
  let n = 1;
  while (used.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

export function PairList({
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
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...pairs, { key: nextPairName(pairs, 'param'), value: '' }])}>
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

function authKind(auth: ApiAuth | undefined): 'none' | ApiAuth['type'] {
  return auth?.type ?? 'none';
}

export function ApiRequestFields({
  api,
  urlHint,
  queryHint,
  bodyHint,
  urlText,
  onUrlText,
  onPatch,
}: {
  api: ApiRequestConfig;
  urlHint: string;
  queryHint?: string;
  bodyHint?: string;
  urlText: string;
  onUrlText: (url: string) => void;
  onPatch: (next: Partial<ApiRequestConfig>) => void;
}) {
  return (
    <>
      <Field label={t(M['inspector.api_method'])}>
        <ToggleGroup
          type="single"
          size="sm"
          appearance="tinted"
          className="w-full"
          aria-label={t(M['inspector.api_method'])}
          value={api.method ?? 'POST'}
          onValueChange={(method) => method && onPatch({ method: method as 'GET' | 'POST' })}
        >
          <ToggleGroupItem value="GET" className="flex-1">{t(M['inspector.api_get'])}</ToggleGroupItem>
          <ToggleGroupItem value="POST" className="flex-1">{t(M['inspector.api_post'])}</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <TextField
        label={t(M['inspector.api_url'])}
        hint={urlHint}
        value={urlText}
        placeholder="https://api.example.com/items"
        onChange={(url) => {
          onUrlText(url);
          if (isSafeUrl(url)) onPatch({ url: url as SafeUrl });
        }}
      />
      <div className="space-y-1.5">
        <p className="text-[13px] font-medium">{t(M['inspector.api_query'])}</p>
        <p className="text-[12px] text-muted-foreground">{queryHint ?? t(M['inspector.api_query_hint'])}</p>
        <PairList pairs={api.query ?? []} addLabel={t(M['inspector.api_add_param'])} onChange={(query) => onPatch({ query })} />
      </div>
      {(api.method ?? 'POST') === 'POST' ? (
        <div className="space-y-1.5">
          <p className="text-[13px] font-medium">{t(M['inspector.api_body'])}</p>
          <p className="text-[12px] text-muted-foreground">{bodyHint ?? t(M['inspector.api_body_hint'])}</p>
          <PairList pairs={api.body ?? []} addLabel={t(M['inspector.api_add_body'])} onChange={(body) => onPatch({ body })} />
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
          if (kind === 'none') onPatch({ auth: undefined });
          else if (kind === 'bearer') onPatch({ auth: { type: 'bearer', token: api.auth?.type === 'bearer' ? api.auth.token : 'token' } });
          else if (kind === 'api_key') onPatch({ auth: { type: 'api_key', header: 'X-API-Key', value: 'key' } });
          else onPatch({ auth: { type: 'basic', username: 'user', password: '' } });
        }}
      />
      {api.auth?.type === 'bearer' ? (
        <TextField label={t(M['inspector.api_token'])} value={api.auth.token} onChange={(token) => token && onPatch({ auth: { type: 'bearer', token } })} />
      ) : null}
      {api.auth?.type === 'api_key' ? (
        <>
          <TextField
            label={t(M['inspector.api_header'])}
            value={api.auth.header}
            onChange={(header) => {
              if (header && api.auth?.type === 'api_key') onPatch({ auth: { type: 'api_key', header, value: api.auth.value } });
            }}
          />
          <TextField
            label={t(M['inspector.api_header_value'])}
            value={api.auth.value}
            onChange={(value) => {
              if (value && api.auth?.type === 'api_key') onPatch({ auth: { type: 'api_key', header: api.auth.header, value } });
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
              if (username && api.auth?.type === 'basic') onPatch({ auth: { type: 'basic', username, password: api.auth.password } });
            }}
          />
          <TextField
            label={t(M['inspector.api_password'])}
            value={api.auth.password}
            onChange={(password) => {
              if (api.auth?.type === 'basic') onPatch({ auth: { type: 'basic', username: api.auth.username, password } });
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
          onValueChange={(parser) => parser && onPatch({ parser: parser as 'json' | 'xml' })}
        >
          <ToggleGroupItem value="json" className="flex-1">{t(M['inspector.api_json'])}</ToggleGroupItem>
          <ToggleGroupItem value="xml" className="flex-1">{t(M['inspector.api_xml'])}</ToggleGroupItem>
        </ToggleGroup>
      </Field>
    </>
  );
}
