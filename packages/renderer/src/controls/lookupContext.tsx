import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useFormContext } from 'react-hook-form';
import type { ApiLookup, PublicFormDefinition } from '@form/schema';
import { buildApiRequest, parseApiBody } from './apiValidation.ts';
import { lookupAnswer, lookupRows, type LookupRow } from './apiLookup.ts';

interface LookupSource {
  rows: LookupRow[];
  apply: (index: number | null) => void;
}

interface LookupContextValue {
  byPicker: Record<string, LookupSource>;
}

const LookupContext = createContext<LookupContextValue | null>(null);

export function useLookup(): LookupContextValue | null {
  return useContext(LookupContext);
}

export function lookupSources(def: { lookup?: ApiLookup; lookups?: ApiLookup[] }): ApiLookup[] {
  if (def.lookups?.length) return def.lookups;
  return def.lookup ? [def.lookup] : [];
}

export function LookupProvider({ def, children }: { def: PublicFormDefinition; children: ReactNode }) {
  const sources = lookupSources(def).filter((source) => source.enabled === true);
  const { setValue } = useFormContext();
  const [rowsById, setRowsById] = useState<Record<string, LookupRow[]>>({});
  const signature = sources.map((source) => [source.id, source.url, source.itemsPath, source.pickerKey, source.parser, source.method].join('|')).join(';');

  useEffect(() => {
    let cancelled = false;
    const ready = sources.filter((source) => source.url && source.itemsPath && source.pickerKey);
    if (!ready.length) {
      setRowsById({});
      return;
    }
    void Promise.all(ready.map(async (source) => {
      try {
        const { url, init } = buildApiRequest(source);
        const text = await (await fetch(url, init)).text();
        const parsed = parseApiBody(text, source.parser ?? 'json');
        return [source.id ?? source.pickerFieldId ?? source.url, parsed.data === undefined ? [] : lookupRows(parsed.data, source)] as const;
      } catch {
        return [source.id ?? source.pickerFieldId ?? source.url, [] as LookupRow[]] as const;
      }
    })).then((entries) => {
      if (!cancelled) setRowsById(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [signature]);

  const value = useMemo<LookupContextValue>(() => {
    const byPicker: Record<string, LookupSource> = {};
    for (const source of sources) {
      if (!source.pickerFieldId) continue;
      const id = source.id ?? source.pickerFieldId;
      const rows = rowsById[id] ?? [];
      byPicker[source.pickerFieldId] = {
        rows,
        apply: (index) => writeRow(def, source, rows, index, setValue),
      };
    }
    return { byPicker };
  }, [def, sources, rowsById, setValue]);

  return <LookupContext.Provider value={value}>{children}</LookupContext.Provider>;
}

function writeRow(
  def: PublicFormDefinition,
  lookup: ApiLookup,
  rows: LookupRow[],
  index: number | null,
  setValue: (name: string, value: unknown, options?: { shouldDirty?: boolean }) => void,
): void {
  if (!lookup.mappings) return;
  const row = index === null ? undefined : rows.find((item) => item.index === index);
  for (const mapping of lookup.mappings) {
    if (!mapping.fieldId) continue;
    const block = def.blocks[mapping.fieldId];
    if (!block || !('type' in block)) continue;
    const text = row?.cells[mapping.key] ?? '';
    if (!row || text === '') {
      setValue(mapping.fieldId, null, { shouldDirty: true });
      continue;
    }
    const answer = lookupAnswer(block.type, text);
    if (answer) setValue(mapping.fieldId, answer, { shouldDirty: true });
  }
}
