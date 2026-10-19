import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fragmentParam, loadSession, type SignInResult } from '@/auth/client';

/**
 * After a first factor: on to the forms when signed in, or to the second-factor page with the ticket. `link_sent`
 * (an emailed link instead of a session) stays on the page, which says so.
 */
export function useFinishSignIn(): (result: SignInResult) => Promise<void> {
  const navigate = useNavigate();
  return useCallback(
    async (result: SignInResult) => {
      if (result.status === 'link_sent') return;
      if (result.status === 'mfa_required') {
        navigate('/auth/mfa', { replace: true, state: { ticket: result.ticket } });
        return;
      }
      await loadSession();
      navigate('/forms', { replace: true });
    },
    [navigate],
  );
}

/**
 * `#token=…`, `#ticket=…` or `#error=…`, read once on arrival and then taken out of the address bar, so a token is
 * not left in the history or on screen. Fragments never reach a server log or a Referer.
 */
export function useFragment(name: 'token' | 'ticket' | 'error'): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const [value] = useState(() => fragmentParam(location.hash, name));
  // Only on arrival: the value is kept in state.
  const arrival = useRef({ location, navigate });
  useEffect(() => {
    const { location: at, navigate: go } = arrival.current;
    if (at.hash) go({ pathname: at.pathname, search: at.search }, { replace: true, state: at.state as unknown });
  }, []);
  return value;
}
