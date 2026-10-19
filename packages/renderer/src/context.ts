import { createContext, useContext } from 'react';
import type { I18n, MessageId, MessageValues } from '@form/i18n';
import type { EvalMeta, PublicFormDefinition, RuntimeFormVersion, ThemeTokens } from '@form/schema';
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
