import { Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { isSafeUrl, type ApiPair, type ApiRequestConfig, type SafeUrl } from '@form/schema';
import { t } from '@/i18n';
import type { Patch } from '@/lib/patch';
import { Alert, AlertDescription, Button, Input, ToggleGroup, ToggleGroupItem } from '@dmacq/ui';
import { Field, TextField } from '@/components/builder/inspector/parts';

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
  'inspector.api_credentials': 'This request carries credentials. The live form sends it from each respondent’s browser, so every respondent could read them. Remove them to publish, and use an API that needs no sign-in.',
  'inspector.api_credentials_remove': 'Remove credentials',
  'inspector.api_exposure': 'Each respondent’s browser sends this request and receives the whole response. Use an API that needs no sign-in and returns only what any respondent may see.',
  'inspector.api_exposure_list': 'Each respondent’s browser loads this API and receives the full response list, every row of it. Use an API that needs no sign-in and lists only what any respondent may see.',
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

export function ApiRequestFields({
  api,
  urlHint,
  queryHint,
  bodyHint,
  urlText,
  onUrlText,
  onPatch,
  list = false,
}: {
  api: ApiRequestConfig;
  /** The response is a list the live form shows (lookups, API options): the warning says every row reaches the browser. */
  list?: boolean;
  urlHint: string;
  queryHint?: string;
  bodyHint?: string;
  urlText: string;
  onUrlText: (url: string) => void;
  onPatch: (next: Patch<ApiRequestConfig>) => void;
}) {
  return (
    <>
      <Alert variant="warning" emphasis="subtle">
        <AlertDescription>{t(M[list ? 'inspector.api_exposure_list' : 'inspector.api_exposure'])}</AlertDescription>
      </Alert>
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
      {/* Step 0 denylist (DEC-03): no credentials in a request the browser sends. An old draft that has them can only remove them. */}
      {api.auth ? (
        <Alert variant="negative" emphasis="subtle">
          <AlertDescription className="space-y-2">
            <p>{t(M['inspector.api_credentials'])}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => onPatch({ auth: undefined })}>
              {t(M['inspector.api_credentials_remove'])}
            </Button>
          </AlertDescription>
        </Alert>
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
