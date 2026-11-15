import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSessionStore, type Me } from '@/auth/client';
import { forgetAccess, previewStatusOf, rememberAccess } from '@/components/builder/access/accessPreview';
import { FormPreview } from '@/components/preview/PreviewPane';
import { richDoc } from '@/lib/definition';
import type { AccessSettings } from '@/persistence/accessApi';
import { block, resetStore } from '@/test/fixtures';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

const settings = (patch: Partial<AccessSettings> = {}): AccessSettings => ({ rev: 1, enabled: true, hasPassword: false, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72, ...patch });

beforeEach(() => forgetAccess());
afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('previewStatusOf', () => {
  it('is closed when the form is switched off (with its screen), password when one is set, else open', () => {
    expect(previewStatusOf(null)).toEqual({ state: 'open' });
    expect(previewStatusOf({ enabled: true, closedMessage: richDoc(''), hasPassword: false })).toEqual({ state: 'open' });
    expect(previewStatusOf({ enabled: false, closedMessage: richDoc('See you next year'), hasPassword: true })).toEqual({ state: 'closed', screen: richDoc('See you next year') });
    expect(previewStatusOf({ enabled: true, closedMessage: richDoc(''), hasPassword: true })).toMatchObject({ state: 'password' });
  });
});

describe('FormPreview and the form’s access on the server', () => {
  it('shows the password screen of a form the server says has a password, and the closed screen of one that is switched off', () => {
    resetStore([block('short_text', 'name', { label: 'Name' })]);
    rememberAccess('test', settings({ hasPassword: true }));
    const { unmount } = render(<FormPreview />);
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    unmount();

    rememberAccess('test', settings({ enabled: false, screens: { closed: { content: richDoc('Registrations are closed.') } } }));
    render(<FormPreview />);
    expect(screen.getByRole('heading', { name: 'Registrations are closed.' })).toBeInTheDocument();
  });

  it('what is held for another form is not shown for this one', () => {
    resetStore([block('short_text', 'name', { label: 'Name' })]);
    rememberAccess('another-form', settings({ hasPassword: true }));
    render(<FormPreview />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });

  it('signed in, it asks the server for the form’s access when the preview opens', async () => {
    resetStore([block('short_text', 'name', { label: 'Name' })]);
    useSessionStore.setState({ status: 'signed_in', me: ME }, true);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ rev: 2, enabled: true, hasPassword: true, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 }), { status: 200, headers: { 'content-type': 'application/json' } })),
      ),
    );
    render(<FormPreview />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/v1/forms/test/access');
  });

  it('a server that cannot answer leaves the preview open', async () => {
    resetStore([block('short_text', 'name', { label: 'Name' })]);
    useSessionStore.setState({ status: 'signed_in', me: ME }, true);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    render(<FormPreview />);
    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });
});
