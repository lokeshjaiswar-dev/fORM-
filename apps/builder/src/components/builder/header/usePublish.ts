import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { runtimeEdition } from '@form/config';
import type { IsoInstant } from '@form/schema';
import { currentDoc } from '@/state/documentStore';
import { useEdition } from '@/edition/edition';
import { previewVersion } from '@/lib/preview';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { flushAutosave } from '@/persistence/autosave';
import { copyText } from '@/lib/copyText';
import { downloadFormJson } from '@/lib/formJson';
import { fillUrl, publishLive, rememberedSlug } from '@/persistence/publishApi';
import { previewLink } from '@/lib/shareLink';

export interface PublishState {
  busy: boolean;
  link: string | null;
  error: string | null;
  shareOpen: boolean;
  setShareOpen: (open: boolean) => void;
  publish: () => Promise<void>;
  exportJson: () => Promise<void>;
  copyLink: () => Promise<void>;
  copyPreviewLink: () => Promise<void>;
}

function publishErrorMessage(err: unknown): string {
  if (err instanceof ApiUnreachable) return 'The API is not running, so this form cannot be shared yet.';
  if (err instanceof ApiProblem) {
    return err.code === 'SERVICE_UNAVAILABLE' || err.code === 'INTERNAL'
      ? 'The database did not answer in time. Try Publish again.'
      : err.message || 'This form could not be published.';
  }
  return err instanceof Error ? err.message : 'This form could not be published.';
}

/** Publish, export and share for the form the URL names. The share dialog reads this state. */
export function usePublish(id: string): PublishState {
  const edition = useEdition();
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(() => {
    const slug = rememberedSlug(id);
    return slug ? fillUrl(slug) : null;
  });

  useEffect(() => {
    const slug = rememberedSlug(id);
    setLink(slug ? fillUrl(slug) : null);
    setError(null);
    setShareOpen(false);
  }, [id]);

  async function publish(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await flushAutosave();
      const doc = currentDoc();
      const built = previewVersion(doc, { state: 'open' }, new Date().toISOString() as IsoInstant, runtimeEdition(edition));
      if (!built.ok) {
        const first = built.issues.find((i) => i.severity === 'error') ?? built.issues[0];
        setError(first?.message ?? 'This form cannot be published yet.');
        setShareOpen(true);
        return;
      }
      const live = await publishLive(id, doc, doc.title);
      setLink(fillUrl(live.slug));
      setShareOpen(true);
    } catch (err) {
      setShareOpen(true);
      setError(publishErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Saves the open form as a JSON file that the Forms page can import. */
  async function exportJson(): Promise<void> {
    setError(null);
    try {
      await flushAutosave();
      downloadFormJson(currentDoc());
      toast.success('Form exported');
    } catch {
      toast.error('The form could not be exported.');
    }
  }

  /** A link that carries the form itself: it opens a read-only preview on any device that can reach this builder. */
  async function copyPreviewLink(): Promise<void> {
    try {
      await flushAutosave();
      await copyText(await previewLink(currentDoc()));
      toast('Preview link copied');
    } catch {
      toast.error('The preview link could not be copied.');
    }
  }

  async function copyLink(): Promise<void> {
    if (!link) return;
    try {
      await copyText(link);
      setError(null);
      toast('Link copied');
    } catch {
      setError('The link could not be copied. Select it and press Ctrl+C.');
    }
  }

  return { busy, link, error, shareOpen, setShareOpen, publish, exportJson, copyLink, copyPreviewLink };
}
