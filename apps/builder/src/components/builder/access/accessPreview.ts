import { useEffect } from 'react';
import { create } from 'zustand';
import type { RichDoc, RuntimeStatus } from '@form/schema';
import { useActiveOrg } from '@/auth/client';
import { closedMessageOf } from '@/components/builder/access/accessModel';
import { getAccess, type AccessSettings } from '@/persistence/accessApi';

/*
 * What the builder's preview knows about a form's access, so it can show the screens a respondent would meet: the closed
 * screen of a form that is switched off and the password screen of a protected one. The server owns the settings (WP-1.07);
 * this is a read-only copy of the last answer for one form, filled by the Access panel when it loads or saves and by the
 * preview itself when it opens. It never holds the password, which the server never sends.
 */

/** The parts of a form's access the preview shows. */
export interface AccessPreview {
  enabled: boolean;
  closedMessage: RichDoc;
  hasPassword: boolean;
}

interface Held {
  formId: string | null;
  preview: AccessPreview | null;
}

export const useAccessPreviewStore = create<Held>()(() => ({ formId: null, preview: null }));

/** Remembers the access of `formId` as the server just said it. */
export function rememberAccess(formId: string, settings: AccessSettings): void {
  useAccessPreviewStore.setState({ formId, preview: { enabled: settings.enabled, closedMessage: closedMessageOf(settings), hasPassword: settings.hasPassword } });
}

/** Forgets what is held (another form opened, or the session ended). */
export function forgetAccess(): void {
  useAccessPreviewStore.setState({ formId: null, preview: null });
}

/**
 * The status the preview shows for a form's access: closed, then password, else open. A form with a close date or a limit
 * is open in the preview: the preview is for checking the form, which a date or a counter should not hide.
 */
export function previewStatusOf(access: AccessPreview | null): RuntimeStatus {
  if (access === null) return { state: 'open' };
  if (!access.enabled) return { state: 'closed', screen: access.closedMessage };
  if (access.hasPassword) return { state: 'password', screen: { type: 'doc', content: [] } };
  return { state: 'open' };
}

/**
 * The preview status of the open form. Signed in, it asks the server for the form's access whenever the preview opens (so
 * a change made in another browser shows), and shows the last answer meanwhile; a form the server does not have yet, or
 * an API that does not answer, previews as open.
 */
export function useAccessPreviewStatus(formId: string): RuntimeStatus {
  const org = useActiveOrg()?.id ?? null;
  const held = useAccessPreviewStore((s) => (s.formId === formId ? s.preview : null));
  useEffect(() => {
    if (org === null) return;
    let live = true;
    getAccess(org, formId).then(
      (settings) => {
        if (live) rememberAccess(formId, settings);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [org, formId]);
  return previewStatusOf(held);
}
