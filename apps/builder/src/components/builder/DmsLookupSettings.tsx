import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { checkDmsV1, dmsTypeOf } from '@form/registry/profiles/dms-v1';
import { DmsMasterLookupSchema, type BlockId, type DmsMasterLookup } from '@form/schema';
import { t } from '@/i18n';
import { APP_IDS, isField, plainText } from '@/lib/definition';
import { setLookups } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { createDmsClient, type DmsClient } from '@/embed/dmsClient';
import { currentLaunch } from '@/embed/launch';
import { sourceElementsOf, sourceFieldsOf, sourceMasterPath, type SourceField } from '@/embed/lookup/dmsRows';
import { NiceSelect } from '@/components/NiceSelect';
import { Alert, AlertDescription, Button, Input, Label } from '@dmacq/ui';

const M = defineMessages('builder', {
  'dms_lookup.hint': 'Fill from master: when someone types in a search field, DMS looks up matching records of another master and fills the fields you choose. It is answered by DMS as the signed-in user; secret and hidden fields cannot be used.',
  'dms_lookup.add': 'Add a lookup',
  'dms_lookup.remove': 'Remove lookup',
  'dms_lookup.master': 'Source master id',
  'dms_lookup.load': 'Load fields',
  'dms_lookup.loading': 'Loading…',
  'dms_lookup.load_failed': 'The master could not be read. Check the id and that you may open it.',
  'dms_lookup.no_launch': 'Open this page from DMS to pick a source master.',
  'dms_lookup.picker': 'Search field in this form',
  'dms_lookup.label': 'Column people search and pick by',
  'dms_lookup.fill': 'Fill these fields',
  'dms_lookup.from': 'Source column',
  'dms_lookup.to': 'Field in this form',
  'dms_lookup.add_fill': 'Add a field to fill',
  'dms_lookup.remove_fill': 'Remove',
  'dms_lookup.min_chars': 'Characters before searching',
  'dms_lookup.save': 'Save lookup',
  'dms_lookup.not_chosen': 'Not chosen',
  'dms_lookup.used': 'Used in another lookup',
  'dms_lookup.invalid': 'This lookup cannot be saved yet: {why}',
  'dms_lookup.secret_note': 'Secret and hidden columns are not listed.',
});

const MASTER_ID = /^[A-Za-z0-9-]{1,64}$/;
const TARGET_TYPES = new Set(['textinput', 'multilineinput', 'numberinput']);

type Fields = Array<{ id: string; name: string }>;

/** The source master's usable columns: those with a name that are flagged neither secret nor hidden (a missing flag counts as hidden). */
export function usableColumns(elements: unknown): Fields {
  const all = sourceFieldsOf(elements);
  const out: Fields = [];
  for (const [id, f] of all as Map<string, SourceField>) if (!f.secret && !f.hidden) out.push({ id, name: f.name });
  return out;
}

/**
 * "Fill from master" for a DMS form (profile dms-v1, server-side lookups F8). Writes a valid `dms_master` lookup, which the
 * profile writes back as the picker's `fp_lookup`. The source master is chosen by id and its columns are read through the
 * classic bridge parent's call (`GET masters/{id}`, which carries the hidden and secret flags), as the signed-in user.
 */
export function DmsLookupSettings({ client }: { client?: Pick<DmsClient, 'request'> }) {
  const doc = useDoc((d) => d);
  const lookups = (doc.lookups ?? []).filter((l): l is DmsMasterLookup => l.source === 'dms_master');
  const [editing, setEditing] = useState<DmsMasterLookup | null>(null);
  const save = (next: DmsMasterLookup[]) => setLookups([...next]);
  const nameOf = (id: string) => {
    const block = doc.blocks[id as BlockId];
    return block && isField(block) ? plainText(block.label) || block.key : id;
  };
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">{t(M['dms_lookup.hint'])}</p>
      {lookups.map((l) => (
        <div key={l.id} className="flex items-center gap-2 rounded-lg border border-sidebar-border px-3 py-2 text-[13px]">
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setEditing(l)}>
            {nameOf(l.pickerFieldId)} ← {l.masterId}
          </button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['dms_lookup.remove'])} onClick={() => { save(lookups.filter((x) => x.id !== l.id)); if (editing?.id === l.id) setEditing(null); }}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      {editing ? (
        <LookupEditor
          key={editing.id}
          initial={editing}
          client={client}
          others={lookups.filter((l) => l.id !== editing.id)}
          onSave={(next) => {
            save([...lookups.filter((l) => l.id !== next.id), next]);
            setEditing(null);
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={lookups.length >= 8}
          onClick={() => setEditing({ id: APP_IDS.newId().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64), source: 'dms_master', enabled: true, masterId: '', pickerFieldId: '' as BlockId, pickerKey: '', mappings: [], minChars: 2 })}
        >
          <Plus className="size-3.5" />
          {t(M['dms_lookup.add'])}
        </Button>
      )}
    </div>
  );
}

function LookupEditor({ initial, others, client, onSave }: { initial: DmsMasterLookup; others: DmsMasterLookup[]; client: Pick<DmsClient, 'request'> | undefined; onSave: (l: DmsMasterLookup) => void }) {
  const doc = useDoc((d) => d);
  const [draft, setDraft] = useState(initial);
  const [columns, setColumns] = useState<Fields>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed' | 'no_launch'>('idle');
  const loaded = initial.masterId !== '' ? initial.masterId : null;

  const load = async (masterId: string) => {
    if (!MASTER_ID.test(masterId)) return setStatus('failed');
    let api = client;
    if (!api) {
      const launch = currentLaunch('dms-master');
      if (!launch.ok) return setStatus('no_launch');
      api = createDmsClient({ apiBase: launch.launch.apiBase, tenantId: launch.launch.tenantId, workspaceId: launch.launch.workspaceId });
    }
    setStatus('loading');
    try {
      // GET masters/{id}: the fields with the flags DMS keeps in master_fields.properties.
      const res = await api.request('GET', sourceMasterPath(masterId));
      setColumns(usableColumns(sourceElementsOf(res)));
      setStatus('idle');
    } catch {
      setColumns([]);
      setStatus('failed');
    }
  };
  useEffect(() => {
    if (loaded) void load(loaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const own = Object.values(doc.blocks).flatMap((b) => (b && isField(b) && dmsTypeOf(b) !== null ? [{ id: b.id as string, type: dmsTypeOf(b)!, name: plainText(b.label) || b.key }] : []));
  const pickers = own.filter((f) => f.type === 'textinput');
  const taken = new Set(others.flatMap((l) => [l.pickerFieldId as string, ...l.mappings.map((m) => m.fieldId as string)]));
  const targets = own.filter((f) => TARGET_TYPES.has(f.type) && f.id !== draft.pickerFieldId);
  const columnOptions = [{ value: 'none', label: t(M['dms_lookup.not_chosen']) }, ...columns.map((c) => ({ value: c.id, label: c.name }))];
  const ownOptions = (list: typeof own) => [
    { value: 'none', label: t(M['dms_lookup.not_chosen']) },
    ...list.map((f) => ({ value: f.id, label: taken.has(f.id) ? `${f.name} — ${t(M['dms_lookup.used'])}` : f.name, disabled: taken.has(f.id) })),
  ];

  const parsed = DmsMasterLookupSchema.safeParse(draft);
  const guard = parsed.success ? checkDmsV1({ ...doc, lookups: [...others, draft] }).filter((i) => i.severity === 'error' && i.code.startsWith('lookup_')) : [];
  const why = !parsed.success ? parsed.error.issues[0]?.path.join('.') || 'incomplete' : (guard[0]?.message ?? '');
  const usedTargets = new Set(draft.mappings.map((m) => m.fieldId as string));

  return (
    <div className="space-y-3 rounded-lg border border-sidebar-border p-3">
      <div className="space-y-1.5">
        <Label htmlFor="dms-lookup-master">{t(M['dms_lookup.master'])}</Label>
        <div className="flex gap-2">
          <Input id="dms-lookup-master" value={draft.masterId} maxLength={64} onChange={(e) => setDraft({ ...draft, masterId: e.target.value.trim() })} />
          <Button type="button" size="sm" disabled={status === 'loading' || !MASTER_ID.test(draft.masterId)} onClick={() => void load(draft.masterId)}>
            {status === 'loading' ? t(M['dms_lookup.loading']) : t(M['dms_lookup.load'])}
          </Button>
        </div>
        {status === 'failed' ? <Alert variant="negative" emphasis="subtle"><AlertDescription>{t(M['dms_lookup.load_failed'])}</AlertDescription></Alert> : null}
        {status === 'no_launch' ? <Alert variant="warning" emphasis="subtle"><AlertDescription>{t(M['dms_lookup.no_launch'])}</AlertDescription></Alert> : null}
        {columns.length > 0 ? <p className="text-[12px] text-muted-foreground">{t(M['dms_lookup.secret_note'])}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label>{t(M['dms_lookup.picker'])}</Label>
        <NiceSelect size="sm" value={draft.pickerFieldId || 'none'} aria-label={t(M['dms_lookup.picker'])} options={ownOptions(pickers)} onChange={(v) => setDraft({ ...draft, pickerFieldId: (v === 'none' ? '' : v) as BlockId })} />
      </div>
      <div className="space-y-1.5">
        <Label>{t(M['dms_lookup.label'])}</Label>
        <NiceSelect size="sm" value={draft.pickerKey || 'none'} aria-label={t(M['dms_lookup.label'])} options={columnOptions} onChange={(v) => setDraft({ ...draft, pickerKey: v === 'none' ? '' : v })} />
      </div>
      <div className="space-y-2">
        <Label>{t(M['dms_lookup.fill'])}</Label>
        {draft.mappings.map((m, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <NiceSelect size="sm" value={m.key || 'none'} aria-label={`${t(M['dms_lookup.from'])} ${i + 1}`} options={columnOptions} onChange={(v) => setDraft({ ...draft, mappings: draft.mappings.map((x, j) => (j === i ? { ...x, key: v === 'none' ? '' : v } : x)) })} />
            </div>
            <div className="min-w-0 flex-1">
              <NiceSelect
                size="sm"
                value={m.fieldId || 'none'}
                aria-label={`${t(M['dms_lookup.to'])} ${i + 1}`}
                options={ownOptions(targets.filter((f) => f.id === m.fieldId || !usedTargets.has(f.id)))}
                onChange={(v) => setDraft({ ...draft, mappings: draft.mappings.map((x, j) => (j === i ? { ...x, fieldId: (v === 'none' ? '' : v) as BlockId } : x)) })}
              />
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['dms_lookup.remove_fill'])} onClick={() => setDraft({ ...draft, mappings: draft.mappings.filter((_, j) => j !== i) })}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" disabled={draft.mappings.length >= 16} onClick={() => setDraft({ ...draft, mappings: [...draft.mappings, { key: '', fieldId: '' as BlockId }] })}>
          <Plus className="size-3.5" />
          {t(M['dms_lookup.add_fill'])}
        </Button>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="dms-lookup-min">{t(M['dms_lookup.min_chars'])}</Label>
        <Input id="dms-lookup-min" type="number" min={0} max={3} value={draft.minChars ?? 2} onChange={(e) => { const n = Math.trunc(Number(e.target.value)); if (Number.isFinite(n) && n >= 0 && n <= 3) setDraft({ ...draft, minChars: n }); }} />
      </div>
      {why ? <p role="status" className="text-[12px] text-muted-foreground">{t(M['dms_lookup.invalid'], { why })}</p> : null}
      <Button type="button" size="sm" disabled={!parsed.success || guard.length > 0} onClick={() => onSave(draft)}>
        {t(M['dms_lookup.save'])}
      </Button>
    </div>
  );
}
