import { useMemo, useState } from 'react';
import type { IsoInstant } from '@form/schema';
import { useDoc } from '@/state/documentStore';
import { PreviewPane } from '@/components/preview/PreviewPane';
import { previewDraft } from '@/lib/preview';

/**
 * Reads the v1 form from the document store and migrates it as a load would; PreviewPane compiles and renders it.
 * Goes when the store holds v2 documents (WP-0.11b).
 */
export function FormPreview() {
  const form = useDoc((d) => d);
  const [now] = useState(() => new Date().toISOString() as IsoInstant);
  const draft = useMemo(() => previewDraft(form, now), [form, now]);
  return <PreviewPane definition={draft.definition} status={draft.status} password={draft.password} />;
}
