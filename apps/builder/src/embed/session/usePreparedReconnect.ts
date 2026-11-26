import { useEffect, useState } from 'react';
import type { SessionSnapshot } from './dmsSession';
import type { HandoffEnv } from './handoff';
import { prepareReconnect, type ExpectedIdentity, type ReconnectDeps, type ReconnectHandle, type ReconnectTarget } from './reconnect';

/** What to reconnect to and who the answer must be, from the page's context (or, after a reload, from the non-secret resume hint). */
export function reconnectPlan(snap: SessionSnapshot, env: HandoffEnv): { target: ReconnectTarget; expected: ExpectedIdentity } | null {
  const apiBase = snap.apiBase ?? (env.apiBases.length === 1 ? (env.apiBases[0] ?? null) : null);
  if (apiBase === null) return null;
  const c = snap.context;
  if (c !== null) {
    return {
      target: { mode: c.mode, masterId: c.master_id, recordId: c.record_id, reconnectUrl: c.reconnect_url, apiBase },
      expected: { mode: c.mode, master_id: c.master_id, record_id: c.record_id, tenant_id: c.tenant_id, workspace_id: c.workspace_id, user_id: c.user.id },
    };
  }
  const h = snap.resume;
  if (h === null) return null;
  return {
    target: { mode: h.mode, masterId: h.master_id, recordId: h.record_id, reconnectUrl: h.reconnect_url, apiBase },
    // A reload knows no tenant, workspace or user: the mode, master and record the hint names must come back.
    expected: { mode: h.mode, master_id: h.master_id, record_id: h.record_id },
  };
}

export type Prepared = { state: 'preparing' } | { state: 'ready'; handle: ReconnectHandle } | { state: 'unavailable' };

/** Keeps one prepared reconnect while `active`; a failed exchange prepares a fresh one (the ticket and verifier are single use). */
export function usePreparedReconnect(snap: SessionSnapshot, env: HandoffEnv, active: boolean, deps?: ReconnectDeps): Prepared {
  const [prepared, setPrepared] = useState<Prepared>({ state: 'preparing' });
  const plan = reconnectPlan(snap, env);
  const key = plan === null ? '' : `${plan.target.mode}|${plan.target.masterId}|${plan.target.recordId}|${plan.target.reconnectUrl}|${plan.target.apiBase}`;
  const failed = snap.reconnect === 'failed';

  useEffect(() => {
    if (!active || plan === null) return;
    let live = true;
    let mine: ReconnectHandle | null = null;
    setPrepared({ state: 'preparing' });
    prepareReconnect(plan.target, plan.expected, env, deps).then(
      (handle) => {
        if (!live) return handle.cancel();
        mine = handle;
        setPrepared({ state: 'ready', handle });
      },
      () => live && setPrepared({ state: 'unavailable' }),
    );
    return () => {
      live = false;
      mine?.cancel();
    };
    // `plan` is derived from `key`; `failed` makes a fresh prepare after an exchange that did not work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, failed]);

  return plan === null ? { state: 'unavailable' } : prepared;
}
