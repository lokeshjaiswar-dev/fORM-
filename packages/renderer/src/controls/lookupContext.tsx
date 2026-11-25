import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useFormContext } from 'react-hook-form';
import { lookupAnswer } from '@form/logic';
import type { PublicFormDefinition, PublicLookup } from '@form/schema';
import { useRenderer } from '../context.ts';
import type { RemoteLookupRow, RemoteSource } from '../remote.ts';

/*
 * Server-side lookups, the respondent's half (contract section 4). The renderer holds no URL and makes no network call: a
 * picker field asks the host's `RemoteSource` (the proxy on a public page, the author route in the builder preview, the
 * bridge in the DMS upload iframe) for rows, and fills the mapped fields from the cells of the row that was picked. With no
 * source the picker stays a plain input.
 */

export interface LookupSource {
  lookup: PublicLookup;
  remote: RemoteSource;
  /** Fills the mapped fields from `row` (and clears them for null). Cells of keys the lookup does not declare are ignored. */
  apply: (row: RemoteLookupRow | null) => void;
}

interface LookupContextValue {
  byPicker: Record<string, LookupSource>;
}

const LookupContext = createContext<LookupContextValue | null>(null);

export function useLookup(): LookupContextValue | null {
  return useContext(LookupContext);
}

export function LookupProvider({ def, children }: { def: PublicFormDefinition; children: ReactNode }) {
  const { remote } = useRenderer();
  const { setValue } = useFormContext();
  const value = useMemo<LookupContextValue>(() => {
    const byPicker: Record<string, LookupSource> = {};
    if (!remote) return { byPicker };
    for (const lookup of def.lookups ?? []) {
      byPicker[lookup.pickerFieldId] = { lookup, remote, apply: (row) => writeRow(def, lookup, row, setValue) };
    }
    return { byPicker };
  }, [def, remote, setValue]);
  return <LookupContext.Provider value={value}>{children}</LookupContext.Provider>;
}

function writeRow(
  def: PublicFormDefinition,
  lookup: PublicLookup,
  row: RemoteLookupRow | null,
  setValue: (name: string, value: unknown, options?: { shouldDirty?: boolean }) => void,
): void {
  for (const mapping of lookup.mappings) {
    const block = def.blocks[mapping.fieldId];
    if (!block || !('type' in block)) continue;
    // Defence in depth: only the keys this lookup declares are read, whatever else the source sent.
    const text = row?.cells[mapping.key] ?? '';
    if (!row || text === '') {
      setValue(mapping.fieldId, null, { shouldDirty: true });
      continue;
    }
    const answer = lookupAnswer(block.type, text);
    if (answer) setValue(mapping.fieldId, answer, { shouldDirty: true });
  }
}
