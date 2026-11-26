import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ticketFx from '@/embed/contract/__fixtures__/launch-ticket.fixtures.json' with { type: 'json' };
import { createDmsClient } from '@/embed/dmsClient';
import { currentLaunch, resetLaunchMemo } from '@/embed/launch';
import { sessionSnapshot } from './dmsSession';
import { writeResume } from './handoff';
import type { ChannelLike } from './reconnect';
import { SessionGate } from './SessionGate';
import { resetTestSession, TEST_API_BASE, testEnv } from './testing';

/*
 * The gate in a browser-like tree: what the user sees at each point of the launch, and that the page under it is kept (state, DOM) while
 * the session is renewed or lost.
 */

const { ticket: TICKET, verifier: VERIFIER } = ticketFx.samples;
const MASTER = 'a1000000-0000-4000-8000-000000000001';
const NEW_CREDENTIAL = 'fps1_NEWnewNEWnewNEWnewNEWnewNEWnewNEWnewNEWnew0';
type Init = RequestInit & { headers: Record<string, string> };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const exchange = (name: string, over: Record<string, unknown> = {}, credential?: string) => {
  const base = ticketFx.exchangeResponse.find((c) => c.name === name)!.input;
  return { ...base, ...(credential ? { credential } : {}), context: { ...base.context, ...over } };
};

class FakeChannel implements ChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  close() {}
  deliver(data: unknown) {
    this.onmessage?.({ data });
  }
}

/** The page under the gate: it reads its launch the way the real pages do and keeps local state we can look for. */
function Page() {
  const launch = currentLaunch('dms-master');
  const [text, setText] = useState('');
  return (
    <div data-testid="page">
      <p data-testid="launch">{launch.ok ? `master:${launch.launch.masterId ?? 'new'}` : 'no launch'}</p>
      <input aria-label="field" value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  );
}

function launchHere(hash: string, verifier: string | null = VERIFIER) {
  if (verifier) sessionStorage.setItem('fp.lv', verifier);
  window.history.replaceState(null, '', `/embed/dms-master${hash}`);
}

function setup(fetch: ReturnType<typeof vi.fn>, channel = new FakeChannel()) {
  const openWindow = vi.fn();
  const deps = { env: testEnv(), fetch: fetch as never, reconnect: { fetch: fetch as never, openWindow, createChannel: () => channel } };
  const view = render(
    <SessionGate mode="dms-master" deps={deps}>
      <Page />
    </SessionGate>,
  );
  return { view, channel, openWindow, deps };
}

beforeEach(() => {
  resetLaunchMemo();
  window.history.replaceState(null, '', '/embed/dms-master');
});
afterEach(() => {
  resetTestSession();
  vi.restoreAllMocks();
});

describe('launch', () => {
  it('exchanges the ticket and then renders the page, which reads its launch from the context', async () => {
    launchHere(`#fpt=${TICKET}`);
    const fetch = vi.fn(async () => json(200, exchange('edit')));
    setup(fetch);
    expect(screen.getByTestId('fp-session-loading')).toBeInTheDocument();
    expect(await screen.findByTestId('page')).toBeInTheDocument();
    expect(screen.getByTestId('launch')).toHaveTextContent(`master:${MASTER}`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('');
  });

  it('a ticket that cannot be exchanged: "Go back to DMS and open the form again", and the button goes back', async () => {
    launchHere(`#fpt=${TICKET}`);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    setup(vi.fn(async () => json(401, { success: false, code: 'FP_TICKET_INVALID', message: 'x', request_id: null })));
    expect(await screen.findByRole('heading', { name: 'Go back to DMS and open the form again' })).toBeInTheDocument();
    expect(screen.queryByTestId('page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go back to DMS' }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('a link opened without the verifier (another tab) shows the same screen and sends nothing', async () => {
    launchHere(`#fpt=${TICKET}`, null);
    const fetch = vi.fn();
    setup(fetch);
    expect(await screen.findByTestId('fp-launch-failed')).toHaveTextContent('Go back to DMS and open the form again');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a #fp= descriptor: "This link is no longer supported. Open the form again from DMS."', async () => {
    launchHere('#fp=eyJ2IjoxfQ', null);
    setup(vi.fn());
    expect(await screen.findByText('This link is no longer supported. Open the form again from DMS.')).toBeInTheDocument();
  });

  it('with no fragment and no hint: "Open this page from DMS"', async () => {
    setup(vi.fn());
    expect(await screen.findByRole('heading', { name: 'This page was not opened from DMS' })).toBeInTheDocument();
    expect(screen.getByText(/Open this page from DMS/)).toBeInTheDocument();
  });

  it('a ticket for another screen (dms-record on the dms-master route) is refused', async () => {
    launchHere(`#fpt=${TICKET}`);
    setup(vi.fn(async () => json(200, exchange('record-edit-30-min'))));
    expect(await screen.findByTestId('fp-launch-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('page')).toBeNull();
  });

  it('DMS temporarily unavailable offers "Try again", which exchanges the same ticket again', async () => {
    launchHere(`#fpt=${TICKET}`);
    const fetch = vi.fn().mockResolvedValueOnce(json(503, { success: false, code: 'LAUNCH_STORE_UNAVAILABLE', message: 'x', request_id: null })).mockResolvedValueOnce(json(200, exchange('edit')));
    setup(fetch);
    expect(await screen.findByText('Forms+ is temporarily unavailable, try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('page')).toBeInTheDocument();
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { ticket: string; verifier: string });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it('survives a StrictMode remount: one exchange, not two', async () => {
    const { StrictMode } = await import('react');
    launchHere(`#fpt=${TICKET}`);
    const fetch = vi.fn(async () => json(200, exchange('edit')));
    const deps = { env: testEnv(), fetch: fetch as never };
    render(
      <StrictMode>
        <SessionGate mode="dms-master" deps={deps}>
          <Page />
        </SessionGate>
      </StrictMode>,
    );
    expect(await screen.findByTestId('page')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('reload', () => {
  const hint = { mode: 'dms-master' as const, master_id: MASTER, record_id: null, reconnect_url: 'https://dms.example.test/dms/t1/formplus/reconnect', return_url: 'https://dms.example.test/dms/t1/documents/master' };

  it('"Session ended" with a Reconnect button and no API call at all; Back to DMS goes to the validated return URL', async () => {
    writeResume(hint);
    const fetch = vi.fn();
    setup(fetch);
    expect(await screen.findByRole('heading', { name: 'Session ended' })).toBeInTheDocument();
    expect(screen.queryByTestId('page')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to DMS' })).toHaveAttribute('href', hint.return_url);
    await waitFor(() => expect(screen.getByTestId('fp-reconnect-button')).toBeEnabled());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Reconnect opens the DMS tab and, once the ticket arrives for our challenge, the page loads', async () => {
    writeResume(hint);
    const fetch = vi.fn(async () => json(200, exchange('edit', {}, NEW_CREDENTIAL)));
    const { channel, openWindow } = setup(fetch);
    const button = await screen.findByTestId('fp-reconnect-button');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(openWindow).toHaveBeenCalledTimes(1);
    const c = new URLSearchParams(new URL(openWindow.mock.calls[0]![0] as string).hash.slice(1)).get('c');
    await act(async () => channel.deliver({ challenge: c, ticket: TICKET }));
    expect(await screen.findByTestId('page')).toBeInTheDocument();
    expect(screen.getByTestId('launch')).toHaveTextContent(`master:${MASTER}`);
  });
});

describe('401 in the middle of work', () => {
  async function running() {
    launchHere(`#fpt=${TICKET}`);
    const fetch = vi.fn(async (url: string, _init?: Init) => (String(url).endsWith('/launch-tickets/exchange') ? json(200, exchange('edit')) : json(200, { success: true })));
    const harness = setup(fetch);
    await screen.findByTestId('page');
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'my unsaved work' } });
    return { fetch, ...harness };
  }

  it('shows the Reconnect banner OVER the kept page; the typed text is still there; after the reconnect the banner is gone and the save is retried', async () => {
    const { fetch, channel, openWindow } = await running();
    fetch.mockImplementation(async (url: string, init?: Init) => {
      if (String(url).endsWith('/launch-tickets/exchange')) return json(200, exchange('edit', {}, NEW_CREDENTIAL));
      return init?.headers.Authorization?.endsWith(NEW_CREDENTIAL) ? json(200, { success: true, data: { id: MASTER } }) : json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null });
    });
    const save = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never }).request('PATCH', `/dms/v1/master/form/${MASTER}`, { name: 'V' });

    const banner = await screen.findByTestId('fp-reconnect-banner');
    expect(banner).toHaveTextContent('what you entered on this page is kept');
    expect(screen.getByLabelText('field')).toHaveValue('my unsaved work');
    const button = within(banner).getByTestId('fp-reconnect-button');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(await within(banner).findByText(/Finish in the DMS tab/)).toBeInTheDocument();

    const c = new URLSearchParams(new URL(openWindow.mock.calls[0]![0] as string).hash.slice(1)).get('c');
    await act(async () => channel.deliver({ challenge: c, ticket: TICKET }));
    await expect(save).resolves.toEqual({ success: true, data: { id: MASTER } });
    await waitFor(() => expect(screen.queryByTestId('fp-reconnect-banner')).toBeNull());
    expect(screen.getByLabelText('field')).toHaveValue('my unsaved work');
  });

  it('"Not now" closes the banner and the parked save fails with the sign-in error; the page and its text stay', async () => {
    const { fetch } = await running();
    fetch.mockImplementation(async () => json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null }));
    const save = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never }).request('GET', `/dms/v1/master/form/${MASTER}`).catch((e: unknown) => e);
    await screen.findByTestId('fp-reconnect-banner');
    fireEvent.click(screen.getByTestId('fp-reconnect-dismiss'));
    expect(await save).toMatchObject({ name: 'DmsAuthError' });
    expect(screen.queryByTestId('fp-reconnect-banner')).toBeNull();
    expect(screen.getByLabelText('field')).toHaveValue('my unsaved work');
  });

  it('a reconnect as someone else blocks the page: "You are signed in as someone else"', async () => {
    const { fetch, channel, openWindow } = await running();
    fetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/launch-tickets/exchange') ? json(200, exchange('edit', { user: { id: 'b0000000-0000-4000-8000-0000000000ff', name: 'Mallory' } }, NEW_CREDENTIAL)) : json(401, { success: false, code: 'FP_SESSION_INVALID', message: 'x', request_id: null }),
    );
    const save = createDmsClient({ apiBase: TEST_API_BASE, tenantId: 't', workspaceId: 'w', fetch: fetch as never }).request('PATCH', `/dms/v1/master/form/${MASTER}`, {}).catch((e: unknown) => e);
    const button = await screen.findByTestId('fp-reconnect-button');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    const c = new URLSearchParams(new URL(openWindow.mock.calls[0]![0] as string).hash.slice(1)).get('c');
    await act(async () => channel.deliver({ challenge: c, ticket: TICKET }));
    expect(await screen.findByRole('heading', { name: 'You are signed in as someone else' })).toBeInTheDocument();
    expect(screen.queryByTestId('page')).toBeNull();
    expect(await save).toMatchObject({ name: 'DmsAuthError' });
    expect(sessionSnapshot().phase).toBe('mismatch');
  });

  it('five minutes before the absolute expiry the banner offers Reconnect before anything fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      launchHere(`#fpt=${TICKET}`);
      const fetch = vi.fn(async () => json(200, { ...exchange('edit'), absolute_expires_in: 1800 }));
      setup(fetch);
      await screen.findByTestId('page');
      expect(screen.queryByTestId('fp-reconnect-banner')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25 * 60_000 + 1000);
      });
      const banner = await screen.findByTestId('fp-reconnect-banner');
      expect(banner).toHaveTextContent('ends in a few minutes');
    } finally {
      vi.useRealTimers();
    }
  });
});
