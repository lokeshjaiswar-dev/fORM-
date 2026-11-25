import { useCallback } from 'react';
import { useActiveOrg } from '@/auth/client';
import { useDoc } from '@/state/documentStore';
import { testRemote, type RemoteTestRequest, type RemoteTestResult } from '@/persistence/remoteApi';

/**
 * The inspector's Test buttons: the request goes through the author route, so the third-party API is called by the server
 * (egress guard, the org's credential) and not by the browser. Throws `RemoteFailed` for any failure, including a form
 * that is not saved on the server yet or a caller without `forms.edit`.
 */
export function useRemoteTest(): (request: RemoteTestRequest, extra?: { q?: string; fieldKey?: string; value?: string | number | boolean }) => Promise<RemoteTestResult> {
  const org = useActiveOrg()?.id ?? null;
  const formId = useDoc((d) => d.formId);
  return useCallback(
    async (request, extra) => {
      if (org === null) throw new Error('No active organisation.');
      return testRemote(org, formId, request, extra);
    },
    [org, formId],
  );
}
