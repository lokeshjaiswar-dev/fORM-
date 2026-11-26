import { createContext, useContext } from 'react';
import { sessionContext } from '@/embed/session/dmsSession';

/*
 * Whether the signed-in user may change the hidden and secret settings of this master's fields (`can.reveal_fields`, SEC-DESIGN 5.2.2:
 * the master's creator, an owner or an administrator; on a create, the creator, so always).
 *
 * The master page provides the answer of `GET v1/master/form/{id}` (`can.reveal_fields`), which dms-api computes for this very master.
 * Without a provider (a create, which has no GET, or a bare inspector) the launch context's value applies: the exchange answered
 * `can.reveal_fields` for this user and this launch. Unknown means no: the toggles stay hidden.
 */
export const RevealCtx = createContext<boolean | null>(null);

export function useCanRevealFields(): boolean {
  const provided = useContext(RevealCtx);
  if (provided !== null) return provided;
  return sessionContext()?.can.reveal_fields === true;
}
