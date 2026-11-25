import { createContext, useContext, type ComponentType } from 'react';
import type { I18n, MessageId, MessageValues } from '@form/i18n';
import type { EvalMeta, PublicFormDefinition, RuntimeFormVersion, StoredBlock, ThemeTokens } from '@form/schema';
import type { RemoteSource } from './remote.ts';
import type { Uploader } from './types.ts';

/** Per-render facts every block needs; the answers and evaluation live in EvalProvider. */
export interface RendererContextValue {
  version: RuntimeFormVersion;
  def: PublicFormDefinition;
  /** The theme in effect: the `theme` prop (builder design preview) or the version's. */
  tokens: ThemeTokens;
  mode: 'live' | 'preview';
  meta: EvalMeta;
  i18n: I18n;
  t: (id: MessageId, values?: MessageValues) => string;
  uploader: Uploader;
  /** Where lookups, API option lists and API checks go (the host's door to the network); absent: they are inert. */
  remote?: RemoteSource | undefined;
  /**
   * Renders one block (label, control, error). Containers (a section, a repeating group) render their children with it.
   * FormRenderer supplies it, because importing `fields/Field.tsx` from a control is a cycle: Field.tsx imports every control.
   */
  Block: ComponentType<{ block: StoredBlock }>;
  /** DOM id prefix for one block, unique per renderer on the page and stable across SSR and hydration. */
  idFor: (blockId: string) => string;
  /** Re-validates a field after its answer changed, once it has shown an error. */
  revalidate: (blockId: string) => void;
  /** Uploads in flight: Next and Submit wait for them before validating. */
  track: <T>(work: Promise<T>) => Promise<T>;
}

export const RendererContext = createContext<RendererContextValue | null>(null);

export function useRenderer(): RendererContextValue {
  const value = useContext(RendererContext);
  if (!value) throw new Error('useRenderer() outside <FormRenderer>');
  return value;
}
