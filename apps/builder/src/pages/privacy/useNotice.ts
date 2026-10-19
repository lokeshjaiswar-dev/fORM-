import { useCallback, useEffect, useState } from 'react';
import { fetchNotice, type PlatformNotice } from '@/auth/client';

export type NoticeState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; notice: PlatformNotice };

/** The platform privacy notice (CMP-21) from the API, with a retry for when it could not be loaded. */
export function useNotice(): { state: NoticeState; reload: () => void } {
  const [state, setState] = useState<NoticeState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetchNotice().then(
      (notice) => live && setState({ status: 'ready', notice }),
      () => live && setState({ status: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  return { state, reload };
}
