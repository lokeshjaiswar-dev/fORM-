import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { defineMessages } from '@form/i18n';
import type { BlockId } from '@form/schema';
import { t } from '@/i18n';
import { currentDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { useBuilderMode } from '@/pages/useBuilderMode';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { rememberAfterSignIn } from '@/auth/returnTo';
import { flushAutosave } from '@/persistence/autosave';
import {
  DraftNotSaved,
  OrgRequired,
  PublishBlocked,
  PublishConflict,
  SignInRequired,
  checkPublishable,
  fillUrl,
  publishLive,
  rememberedSlug,
  type PublishIssueView,
} from '@/persistence/publishApi';

const M = defineMessages('builder', {
  'header.plan_mismatch': 'This browser and the server disagree about how the form compiles. Reload the page, then publish again.',
  'header.conflict_toast': 'This form changed somewhere else. Choose which version to keep, then publish again.',
});

/** What the publish dialog lists: the server's issues, and whether any of them blocks. */
export interface PublishIssues {
  issues: PublishIssueView[];
  count: number;
}

export interface PublishState {
  busy: boolean;
  link: string | null;
  error: string | null;
  shareOpen: boolean;
  setShareOpen: (open: boolean) => void;
  /** The server's issues for the draft, while the issues dialog is open. */
  listed: PublishIssues | null;
  closeListed: () => void;
  /** Publish: `confirmed` publishes a draft whose only issues are warnings. */
  publish: (confirmed?: boolean) => Promise<void>;
  /** Opens the inspector of the block an issue is about (in Edit, where the inspector is). */
  goToField: (blockId: BlockId) => void;
  /** Cleared when a link is copied. */
  clearError: () => void;
}

/**
 * Publish for the form the URL names. The draft is saved, the server checks it (`/validate`), and only a draft with no
 * error goes on to publish; warnings are listed first and published on confirmation (`confirmed`). The share dialog and
 * the issues dialog read this state.
 */
export function usePublish(id: string): PublishState {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [mode, setMode] = useBuilderMode();
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listed, setListed] = useState<PublishIssues | null>(null);
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

  /** Freezes the saved draft as the live version and shows the share link. */
  async function publishDraft(): Promise<void> {
    const live = await publishLive(id, currentDoc());
    setListed(null);
    setLink(fillUrl(live.slug));
    setShareOpen(true);
  }

  async function publish(confirmed = false): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await flushAutosave();
      if (!confirmed) {
        const check = await checkPublishable(id);
        const blocking = check.issues.some((i) => i.severity === 'error');
        if (blocking || check.issues.length) {
          setListed({ issues: check.issues, count: check.issueCount });
          return;
        }
      }
      await publishDraft();
    } catch (err) {
      // Not signed in (or the session ended): the draft is already saved in this browser, so sign in and come back.
      if (err instanceof SignInRequired || (err instanceof ApiProblem && err.status === 401)) {
        rememberAfterSignIn(pathname);
        toast('Sign in to publish. Your form is saved in this browser.');
        navigate('/auth/sign-in');
        return;
      }
      if (err instanceof OrgRequired) {
        rememberAfterSignIn(pathname);
        toast('Create an organisation first: forms are published into one.');
        navigate('/orgs/new');
        return;
      }
      if (err instanceof PublishBlocked && err.code === 'PUBLISH_BLOCKED') {
        setListed({ issues: err.issues, count: err.issueCount });
        return;
      }
      // The merge dialog is open already; it is what the author needs to answer.
      if (err instanceof PublishConflict) {
        toast(t(M['header.conflict_toast']));
        return;
      }
      if (err instanceof DraftNotSaved && err.conflict) return;
      setShareOpen(true);
      if (err instanceof PublishBlocked) setError(t(M['header.plan_mismatch']));
      else if (err instanceof ApiUnreachable) setError('The API is not running, so this form cannot be shared yet.');
      else if (err instanceof ApiProblem) {
        setError(
          err.code === 'SERVICE_UNAVAILABLE' || err.code === 'INTERNAL'
            ? 'This form could not be published right now. Try Publish again in a moment.'
            : err.message || 'This form could not be published.',
        );
      } else setError(err instanceof Error ? err.message : 'This form could not be published.');
    } finally {
      setBusy(false);
    }
  }

  function goToField(blockId: BlockId): void {
    if (!currentDoc().blocks[blockId]) return;
    setListed(null);
    if (mode === 'preview') setMode('edit');
    useUiStore.getState().openInspector(blockId);
  }

  return { busy, link, error, shareOpen, setShareOpen, listed, closeListed: () => setListed(null), publish, goToField, clearError: () => setError(null) };
}
