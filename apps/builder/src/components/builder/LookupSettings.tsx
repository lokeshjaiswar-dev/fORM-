import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { buildApiRequest, getAtPath, parseApiBody } from '@form/renderer/author';
import { isSafeUrl, type ApiLookup, type BlockId, type SafeUrl } from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { applyPatch, type Patch } from '@/lib/patch';
import { APP_IDS, isField } from '@/lib/definition';
import { useDraft } from '@/lib/useDraft';
import { setLookups } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
  Alert, AlertDescription, Badge, Button, Input, Label, RadioField, RadioGroup, Separator, Switch,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@dmacq/ui';
import { ApiRequestFields } from '@/components/builder/inspector/apiRequest';
import { ApiResponseTree } from '@/components/builder/inspector/ApiResponseTree';
import { NiceSelect } from '@/components/NiceSelect';

const M = defineMessages('builder', {
  'lookup.add': 'Add an API',
  'lookup.api_key': 'API key',
  'lookup.configure_first': 'Configure this API first: map at least one response key to a form field before turning it on.',
  'lookup.empty': 'The response had no list to use.',
  'lookup.fail': 'The request could not be sent. Check the URL and that the API allows this origin.',
  'lookup.field': 'Form field',
  'lookup.hint': 'Each API fills its own fields. A field already mapped stays visible and cannot be used again.',
  'lookup.keys': 'Response keys',
  'lookup.name': 'Name',
  'lookup.none': 'Not mapped',
  'lookup.other_list': '{picked} comes from a different branch. This API is already using {current}. Add another API for {picked}.',
  'lookup.parse': 'The response could not be parsed as {format}.',
  'lookup.pick_list': 'Click a value to add it. Nested values are added as a path.',
  'lookup.remove_key': 'Remove key',
  'lookup.picker': 'Dropdown',
  'lookup.on': 'On',
  'lookup.remove': 'Remove',
  'lookup.save': 'Save',
  'lookup.test': 'Test',
  'lookup.testing': 'Testing…',
  'lookup.turn_off': '{fields} are already used in {name}. Turn {name} off before turning this API on.',
  'lookup.used': 'Used in {name}',
  'lookup.url_hint': 'The list of records to pick from, for example https://api.example.com/directory.',
});

const TEXT_TYPES = new Set(['short_text', 'long_text', 'url', 'number']);

/**
 * A new lookup starts with no URL (review N3). A lookup must have a URL to be stored, so the new one stays in this panel
 * until the author saves a valid URL.
 */
function freshLookup(n: number): ApiLookup {
  return {
    id: APP_IDS.newId(),
    name: `API ${n}`,
    url: '' as SafeUrl,
    enabled: false,
    method: 'GET',
    parser: 'json',
  };
}

/** Key on one row of the nearest list. Ignores the options-tree map heuristic. */
function lookupField(data: unknown, path: string): { itemsPath?: string; field: string } | undefined {
  const segs: ({ kind: 'key'; key: string } | { kind: 'index'; index: number })[] = [];
  const re = /\[(\d+)\]|[^.[\]]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path))) {
    segs.push(match[1] !== undefined ? { kind: 'index', index: Number(match[1]) } : { kind: 'key', key: match[0] });
  }
  let cur: unknown = data;
  let prefix = '';
  let itemsPath: string | undefined;
  const field: string[] = [];
  for (const seg of segs) {
    if (Array.isArray(cur) && seg.kind === 'index') {
      if (itemsPath === undefined) itemsPath = prefix;
      else field.push(String(seg.index));
      cur = cur[seg.index];
      continue;
    }
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && seg.kind === 'key') {
      if (itemsPath !== undefined) field.push(seg.key);
      else prefix = prefix ? `${prefix}.${seg.key}` : seg.key;
      cur = (cur as Record<string, unknown>)[seg.key];
      continue;
    }
    return undefined;
  }
  if (cur !== null && typeof cur === 'object') return undefined;
  if (itemsPath === undefined) return prefix ? { field: prefix } : undefined;
  if (field.length === 0) return undefined;
  return { itemsPath, field: field.join('.') };
}

function sampleKeys(data: unknown, itemsPath: string | undefined): string[] {
  if (itemsPath === undefined) return [];
  const at = itemsPath ? getAtPath(data, itemsPath) : data;
  if (!Array.isArray(at)) return [];
  const sample = at.find((row) => row && typeof row === 'object' && !Array.isArray(row));
  return sample && typeof sample === 'object' ? Object.keys(sample as object) : [];
}

function sourcesOf(lookups: ApiLookup[] | undefined, legacy: ApiLookup | undefined): ApiLookup[] {
  if (lookups?.length) return lookups.map((source, i) => ({ ...source, id: source.id ?? `lookup-${i}` }));
  if (legacy) return [{ ...legacy, id: legacy.id ?? 'lookup-0', name: legacy.name ?? 'API 1' }];
  return [];
}

function usedElsewhere(sources: ApiLookup[], currentId: string): Map<string, string> {
  const taken = new Map<string, string>();
  for (const source of sources) {
    if ((source.id ?? '') === currentId || source.enabled !== true) continue;
    const name = source.name ?? source.url;
    for (const mapping of source.mappings ?? []) if (mapping.fieldId) taken.set(mapping.fieldId, name);
    if (source.pickerFieldId) taken.set(source.pickerFieldId, name);
  }
  return taken;
}

export function LookupSettings() {
  const doc = useDoc((d) => d);
  const sources = sourcesOf(doc.lookups, doc.lookup);
  const [pending, setPending] = useState<ApiLookup>();
  const [open, setOpen] = useState(sources[0]?.id ?? '');
  const save = (next: ApiLookup[]) => setLookups(next);
  const shown = pending ? [...sources, pending] : sources;
  const fields = Object.values(doc.blocks).flatMap((block) => {
    if (!block || !isField(block) || !TEXT_TYPES.has(block.type)) return [];
    const label = block.label;
    const text = typeof label === 'string' || Array.isArray(label) ? labelString(label) : '';
    return [{ value: block.id, label: text || block.key }];
  });

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">{t(M['lookup.hint'])}</p>
      {shown.length ? (
        <Accordion type="single" collapsible value={open} onValueChange={setOpen} className="space-y-2">
          {shown.map((source) => (
            <LookupAccordion
              key={source.id}
              source={source}
              fields={fields}
              taken={usedElsewhere(sources, source.id ?? '')}
              onChange={(next) => {
                if (source === pending) {
                  if (!isSafeUrl(next.url)) return;
                  setPending(undefined);
                  save([...sources, next]);
                } else save(sources.map((item) => (item.id === source.id ? next : item)));
              }}
              onRemove={() => (source === pending ? setPending(undefined) : save(sources.filter((item) => item.id !== source.id)))}
            />
          ))}
        </Accordion>
      ) : null}
      <Button type="button" variant="outline" size="sm" disabled={sources.length >= 8 || pending !== undefined} onClick={() => {
          const fresh = freshLookup(sources.length + 1);
          setPending(fresh);
          setOpen(fresh.id ?? '');
        }}>
        {t(M['lookup.add'])}
      </Button>
    </div>
  );
}

function LookupAccordion({
  source,
  fields,
  taken,
  onChange,
  onRemove,
}: {
  source: ApiLookup;
  fields: { value: string; label: string }[];
  taken: Map<string, string>;
  onChange: (next: ApiLookup) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(source);
  const [urlText, setUrlText] = useDraft<string>(draft.url);
  const [status, setStatus] = useState<'idle' | 'testing' | 'fail' | 'parse' | 'empty' | 'ok'>('idle');
  const [data, setData] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState('');
  const keys = (draft.mappings ?? []).map((row) => row.key);

  const patch = (next: Patch<ApiLookup>) => {
    const merged = applyPatch(draft, next);
    for (const key of ['query', 'body', 'auth', 'itemsPath', 'pickerFieldId', 'pickerKey', 'mappings', 'name'] as const) {
      if (merged[key] === undefined) delete merged[key];
    }
    setDraft(merged);
  };

  const setMapping = (key: string, fieldId: string) => {
    const mappings = (draft.mappings ?? []).map((row) => (row.key === key ? { key, ...(fieldId ? { fieldId: fieldId as BlockId } : {}) } : row));
    const pickerCleared = draft.pickerKey === key && !fieldId;
    patch({
      mappings,
      ...(pickerCleared ? { pickerKey: undefined, pickerFieldId: undefined } : {}),
      ...(draft.pickerKey === key && fieldId ? { pickerFieldId: fieldId as BlockId } : {}),
    });
  };

  const addKey = (path: string, part: 'leaf' | 'entryKey' | 'list') => {
    if (!data || part === 'list') return;
    const picked = lookupField(data, path);
    if (!picked) return;
    const current = draft.itemsPath;
    if (picked.itemsPath && current && current !== picked.itemsPath && (draft.mappings ?? []).length > 0) {
      const listName = (value: string) => value.split('.').pop() || value;
      setNotice(t(M['lookup.other_list'], { current: listName(current), picked: listName(picked.itemsPath) }));
      return;
    }
    setNotice('');
    if ((draft.mappings ?? []).some((row) => row.key === picked.field)) return;
    patch({
      ...(picked.itemsPath ? { itemsPath: picked.itemsPath } : {}),
      mappings: [...(draft.mappings ?? []), { key: picked.field }],
    });
  };

  const removeKey = (key: string) => {
    const mappings = (draft.mappings ?? []).filter((row) => row.key !== key);
    if (!mappings.length) setNotice('');
    patch({
      mappings: mappings.length ? mappings : undefined,
      ...(mappings.length ? {} : { itemsPath: undefined }),
      ...(draft.pickerKey === key ? { pickerKey: undefined, pickerFieldId: undefined } : {}),
    });
  };

  const test = async () => {
    if (!isSafeUrl(draft.url)) return;
    setStatus('testing');
    setData(undefined);
    try {
      const { url, init } = buildApiRequest(draft);
      const res = await fetch(url, init);
      const text = await res.text();
      const parsed = parseApiBody(text, draft.parser ?? 'json');
      if (parsed.data === undefined) {
        setStatus(text.trim() ? 'parse' : 'empty');
        return;
      }
      setData(parsed.data);
      setStatus(sampleKeys(parsed.data, draft.itemsPath).length || draft.itemsPath === undefined ? 'ok' : 'empty');
    } catch {
      setStatus('fail');
    }
  };

  const options = [
    { value: 'none', label: t(M['lookup.none']) },
    ...fields.map((field) => {
      const owner = taken.get(field.value);
      return owner ? { ...field, label: `${field.label} — ${t(M['lookup.used'], { name: owner })}`, disabled: true } : field;
    }),
  ];

  return (
    <AccordionItem value={draft.id ?? draft.url} className="rounded-lg border border-sidebar-border bg-sidebar-accent/20 px-3">
      <div className="flex items-center gap-2">
        <AccordionTrigger className="min-w-0 flex-1 py-3 hover:no-underline">
          <span className="truncate text-left text-[14px] font-medium">{draft.name || draft.url}</span>
        </AccordionTrigger>
        <span className="flex items-center gap-2 text-[12px]">
          <span>{t(M['lookup.on'])}</span>
          <Switch
            checked={draft.enabled === true}
            disabled={!isSafeUrl(source.url)}
            aria-label={t(M['lookup.on'])}
            onCheckedChange={(on) => {
              if (on) {
                if (!(draft.mappings ?? []).some((row) => row.fieldId)) {
                  setConflict(t(M['lookup.configure_first']));
                  return;
                }
                const ids = new Set<string>();
                for (const row of draft.mappings ?? []) if (row.fieldId) ids.add(row.fieldId);
                if (draft.pickerFieldId) ids.add(draft.pickerFieldId);
                const owners = new Map<string, string[]>();
                for (const id of ids) {
                  const owner = taken.get(id);
                  if (!owner) continue;
                  const label = fields.find((field) => field.value === id)?.label ?? id;
                  owners.set(owner, [...(owners.get(owner) ?? []), label]);
                }
                if (owners.size) {
                  const [name, labels] = [...owners.entries()][0]!;
                  setConflict(t(M['lookup.turn_off'], { fields: labels.join(', '), name }));
                  return;
                }
              }
              setConflict('');
              setDraft({ ...draft, enabled: on });
              onChange({ ...source, enabled: on });
            }}
          />
        </span>
        <Button type="button" variant="ghost" size="icon" aria-label={t(M['lookup.remove'])} onClick={onRemove}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      {conflict ? <Alert variant="warning" emphasis="subtle" className="mb-3"><AlertDescription>{conflict}</AlertDescription></Alert> : null}
      <AccordionContent className="space-y-4 pb-4">
        <div className="space-y-1.5">
          <Label htmlFor={`lookup-name-${draft.id}`}>{t(M['lookup.name'])}</Label>
          <Input
            id={`lookup-name-${draft.id}`}
            value={draft.name ?? ''}
            onChange={(e) => patch({ name: e.target.value.trim() ? e.target.value : undefined })}
          />
        </div>
        <ApiRequestFields
          api={draft}
          list
          urlHint={t(M['lookup.url_hint'])}
          queryHint=""
          bodyHint=""
          urlText={urlText}
          onUrlText={setUrlText}
          onPatch={(next) => patch(next)}
        />
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={status === 'testing'} onClick={() => void test()}>
            {status === 'testing' ? t(M['lookup.testing']) : t(M['lookup.test'])}
          </Button>
          <Button type="button" size="sm" disabled={!isSafeUrl(draft.url)} onClick={() => onChange(draft)}>
            {t(M['lookup.save'])}
          </Button>
        </div>
        {status === 'fail' ? <Alert variant="negative" emphasis="subtle"><AlertDescription>{t(M['lookup.fail'])}</AlertDescription></Alert> : null}
        {status === 'parse' ? <Alert variant="warning" emphasis="subtle"><AlertDescription>{t(M['lookup.parse'], { format: (draft.parser ?? 'json').toUpperCase() })}</AlertDescription></Alert> : null}
        {status === 'empty' ? <Alert variant="info" emphasis="subtle"><AlertDescription>{t(M['lookup.empty'])}</AlertDescription></Alert> : null}
        {status === 'ok' && data !== undefined ? (
          <>
            <Separator />
            <div className="space-y-2">
              <Label>{t(M['lookup.keys'])}</Label>
              <p className="text-sm text-muted-foreground">{t(M['lookup.pick_list'])}</p>
              <ApiResponseTree
                data={data}
                mode="options"
                selected={draft.itemsPath}
                onSelect={(path, part) => addKey(path, part)}
                onUse={() => undefined}
              />
              {notice ? <Alert variant="warning" emphasis="subtle"><AlertDescription>{notice}</AlertDescription></Alert> : null}
            </div>
          </>
        ) : null}
        {keys.length ? (
          <RadioGroup
            value={draft.pickerKey ?? ''}
            onValueChange={(key) => {
              const mapping = draft.mappings?.find((row) => row.key === key);
              if (mapping) patch({ pickerKey: key, pickerFieldId: mapping.fieldId });
            }}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t(M['lookup.api_key'])}</TableHead>
                  <TableHead>{t(M['lookup.field'])}</TableHead>
                  <TableHead className="w-28">{t(M['lookup.picker'])}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => {
                  const mapping = draft.mappings?.find((row) => row.key === key);
                  return (
                    <TableRow key={key}>
                      <TableCell><Badge variant="secondary" className="font-mono">{key}</Badge></TableCell>
                      <TableCell>
                        <NiceSelect
                          size="sm"
                          value={mapping?.fieldId ?? 'none'}
                          onChange={(fieldId) => setMapping(key, fieldId === 'none' ? '' : fieldId)}
                          options={options}
                          aria-label={key}
                        />
                      </TableCell>
                      <TableCell>
                        <RadioField value={key} label="" size="sm" disabled={!mapping?.fieldId} />
                      </TableCell>
                      <TableCell>
                        <Button type="button" variant="ghost" size="icon" aria-label={t(M['lookup.remove_key'])} onClick={() => removeKey(key)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </RadioGroup>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  );
}
