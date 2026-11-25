import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Field,
  Input,
} from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import type { ApiAuth } from '@form/schema';
import { t } from '@/i18n';
import { ApiProblem, useActiveOrg } from '@/auth/client';
import { NiceSelect } from '@/components/NiceSelect';
import { problemText, submit } from '@/pages/auth/util';
import {
  addApiCredential,
  canManageApiCredentials,
  changeApiCredential,
  deleteApiCredential,
  listApiCredentials,
  type ApiCredential,
} from '@/persistence/remoteApi';

const M = defineMessages('builder', {
  'api_credentials.title': 'API credentials',
  'api_credentials.back': 'Back to organisation settings',
  'api_credentials.intro': 'Sign-ins for the APIs your forms call (lookups, option lists, checks). The server adds a credential to a request, only over https and only to the host it was saved for. Respondents and form editors never see the secret.',
  'api_credentials.loading': 'Loading credentials…',
  'api_credentials.sign_in': 'Sign in to see your organisation’s API credentials.',
  'api_credentials.forbidden': 'You do not have permission to see the API credentials.',
  'api_credentials.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'api_credentials.retry': 'Try again',
  'api_credentials.none': 'No credentials yet.',
  'api_credentials.read_only': 'Only owners and admins can add, rotate or delete credentials.',
  'api_credentials.summary': '{type} for {host}',
  'api_credentials.ends_with': 'ends with {last4}',
  'api_credentials.rotated': 'Rotated {when}',
  'api_credentials.type_bearer': 'Bearer token',
  'api_credentials.type_api_key': 'API key header',
  'api_credentials.type_basic': 'Basic sign-in',
  'api_credentials.rotate': 'Rotate',
  'api_credentials.rotate_credential': 'Rotate {name}',
  'api_credentials.delete': 'Delete',
  'api_credentials.delete_credential': 'Delete {name}',
  'api_credentials.delete_title': 'Delete “{name}”?',
  'api_credentials.delete_text': 'The secret is deleted with it. A form that still uses this credential stops publishing until you pick another one.',
  'api_credentials.delete_cancel': 'Keep it',
  'api_credentials.delete_confirm': 'Delete credential',
  'api_credentials.form_add': 'Add a credential',
  'api_credentials.form_rotate': 'Rotate {name}',
  'api_credentials.name': 'Name',
  'api_credentials.host': 'Host',
  'api_credentials.host_hint': 'The one host this credential may be sent to, for example api.example.com or api.example.com:8443.',
  'api_credentials.type': 'Type',
  'api_credentials.token': 'Token',
  'api_credentials.header': 'Header name',
  'api_credentials.value': 'Key',
  'api_credentials.username': 'User name',
  'api_credentials.password': 'Password',
  'api_credentials.secret_hint': 'Typed once and stored sealed. It is never shown again, so keep it somewhere safe.',
  'api_credentials.secret_keep': 'Leave the secret empty to keep the one stored now.',
  'api_credentials.host_needs_secret': 'To send this credential to a new host, enter the secret again.',
  'api_credentials.save_add': 'Add credential',
  'api_credentials.save_rotate': 'Save changes',
  'api_credentials.cancel': 'Cancel',
  'api_credentials.saved': 'Credential saved.',
  'api_credentials.deleted': 'Credential deleted.',
});

type Blocked = 'sign_in' | 'forbidden' | 'unreachable';
const BLOCKED_TEXT: Readonly<Record<Blocked, MessageId>> = {
  sign_in: M['api_credentials.sign_in'],
  forbidden: M['api_credentials.forbidden'],
  unreachable: M['api_credentials.unreachable'],
};
const TYPE_TEXT: Readonly<Record<ApiCredential['type'], MessageId>> = {
  bearer: M['api_credentials.type_bearer'],
  api_key: M['api_credentials.type_api_key'],
  basic: M['api_credentials.type_basic'],
};

function blockedBy(err: unknown): Blocked {
  if (err instanceof ApiProblem) {
    if (err.status === 401) return 'sign_in';
    if (err.status === 403) return 'forbidden';
  }
  return 'unreachable';
}

/**
 * `/org/api-credentials`: the org's API credentials (server-side lookups). Anyone who edits a form can pick one by name and
 * host; adding, rotating and deleting need `org.settings`, which the API checks again on every call. The secret is
 * write-only: its boxes are password inputs that start empty and are emptied as soon as the save is accepted, and the list
 * shows only the name, the type, the host and, when the secret is long enough, its last four characters.
 */
export function ApiCredentialsPage() {
  const org = useActiveOrg()?.id ?? null;
  return (
    <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-8 text-foreground">
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-3">
        <Link to="/org/settings">
          <ArrowLeft />
          {t(M['api_credentials.back'])}
        </Link>
      </Button>
      <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em]">{t(M['api_credentials.title'])}</h1>
      <p className="mt-3 text-[15px] leading-6 text-muted-foreground">{t(M['api_credentials.intro'])}</p>
      <Credentials key={org ?? ''} org={org} />
    </main>
  );
}

function Credentials({ org }: { org: string | null }) {
  const [items, setItems] = useState<ApiCredential[] | null>(null);
  const [manage, setManage] = useState(false);
  const [blocked, setBlocked] = useState<Blocked | null>(org === null ? 'sign_in' : null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rotating, setRotating] = useState<ApiCredential | null>(null);
  const [asking, setAsking] = useState<ApiCredential | null>(null);

  useEffect(() => {
    if (org === null) return;
    let live = true;
    Promise.all([listApiCredentials(org), canManageApiCredentials(org)]).then(
      ([all, may]) => {
        if (!live) return;
        setItems(all);
        setManage(may);
      },
      (err: unknown) => live && setBlocked(blockedBy(err)),
    );
    return () => {
      live = false;
    };
  }, [org, attempt]);

  async function remove(credential: ApiCredential) {
    setAsking(null);
    if (org === null) return;
    setError(null);
    setNotice(null);
    try {
      await deleteApiCredential(org, credential.id);
      setItems((all) => (all ?? []).filter((c) => c.id !== credential.id));
      setRotating((r) => (r?.id === credential.id ? null : r));
      setNotice(t(M['api_credentials.deleted']));
    } catch (err) {
      setError(problemText(err));
    }
  }

  if (blocked) {
    return (
      <div className="mt-6 space-y-2">
        <Alert variant="warning" icon>
          <AlertDescription>{t(BLOCKED_TEXT[blocked])}</AlertDescription>
        </Alert>
        {blocked === 'unreachable' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => { setBlocked(null); setAttempt((n) => n + 1); }}>
            {t(M['api_credentials.retry'])}
          </Button>
        ) : null}
      </div>
    );
  }
  if (items === null) return <p className="mt-6 text-[14px] text-muted-foreground">{t(M['api_credentials.loading'])}</p>;

  return (
    <div className="mt-6">
      {error ? <Alert variant="destructive" icon className="mb-4"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {notice ? <p role="status" className="mb-4 text-[13px] text-muted-foreground">{notice}</p> : null}

      {items.length === 0 ? (
        <p className="text-[14px] text-muted-foreground">{t(M['api_credentials.none'])}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {items.map((c) => (
            <li key={c.id} className="space-y-1.5 px-3 py-3 text-[14px]">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                {c.last4 ? <Badge variant="secondary" size="sm">{t(M['api_credentials.ends_with'], { last4: c.last4 })}</Badge> : null}
              </div>
              <p className="text-[13px] text-muted-foreground">
                {t(M['api_credentials.summary'], { type: t(TYPE_TEXT[c.type]), host: c.host })}
                {c.header ? ` (${c.header})` : ''}
              </p>
              {c.rotatedAt ? <p className="text-[13px] text-muted-foreground">{t(M['api_credentials.rotated'], { when: c.rotatedAt.slice(0, 10) })}</p> : null}
              {manage ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button type="button" size="sm" variant="outline" aria-label={t(M['api_credentials.rotate_credential'], { name: c.name })} onClick={() => setRotating(c)}>
                    {t(M['api_credentials.rotate'])}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" aria-label={t(M['api_credentials.delete_credential'], { name: c.name })} onClick={() => setAsking(c)}>
                    {t(M['api_credentials.delete'])}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {manage && org !== null ? (
        <CredentialForm
          key={rotating?.id ?? 'new'}
          org={org}
          credential={rotating}
          onDone={(saved) => {
            if (saved) {
              setItems((all) => (all?.some((c) => c.id === saved.id) ? all.map((c) => (c.id === saved.id ? saved : c)) : [...(all ?? []), saved]));
              setNotice(t(M['api_credentials.saved']));
              setError(null);
            }
            setRotating(null);
          }}
        />
      ) : (
        <p className="mt-4 text-[13px] text-muted-foreground">{t(M['api_credentials.read_only'])}</p>
      )}

      <AlertDialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(M['api_credentials.delete_title'], { name: asking?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t(M['api_credentials.delete_text'])}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(M['api_credentials.delete_cancel'])}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => asking && void remove(asking)}>
              {t(M['api_credentials.delete_confirm'])}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Adds a credential, or rotates `credential` (a new secret; an empty secret keeps the stored one and only name or host change).
 * The secret boxes are password inputs, start empty, and are emptied again as soon as the server has the secret.
 */
function CredentialForm({ org, credential, onDone }: { org: string; credential: ApiCredential | null; onDone: (saved: ApiCredential | null) => void }) {
  const [name, setName] = useState(credential?.name ?? '');
  const [host, setHost] = useState(credential?.host ?? '');
  const [type, setType] = useState<ApiCredential['type']>(credential?.type ?? 'bearer');
  const [token, setToken] = useState('');
  const [header, setHeader] = useState(credential?.header ?? 'X-API-Key');
  const [value, setValue] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const auth = (): ApiAuth | null => {
    if (type === 'bearer') return token.trim() === '' ? null : { type, token: token.trim() };
    if (type === 'api_key') return value === '' || header.trim() === '' ? null : { type, header: header.trim(), value };
    return username.trim() === '' || password === '' ? null : { type, username: username.trim(), password };
  };
  const secret = auth();
  const typeChanged = credential !== null && type !== credential.type;
  // The server takes a new host only with the secret sent again: a stored secret is never re-aimed at another host.
  const hostChanged = credential !== null && host.trim().toLowerCase() !== credential.host;
  const ready = name.trim() !== '' && host.trim() !== '' && (credential === null ? secret !== null : !(typeChanged || hostChanged) || secret !== null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let saved: ApiCredential;
      if (credential) {
        const change: { name?: string; host?: string; auth?: ApiAuth } = {};
        if (name.trim() !== credential.name) change.name = name.trim();
        if (host.trim() !== credential.host) change.host = host.trim();
        if (secret) change.auth = secret;
        if (Object.keys(change).length === 0) return onDone(null);
        saved = await changeApiCredential(org, credential.id, change);
      } else {
        if (!secret) return;
        saved = await addApiCredential(org, { name: name.trim(), host: host.trim(), auth: secret });
      }
      // The secret is gone from this page the moment the server has it.
      setToken('');
      setValue('');
      setPassword('');
      if (!credential) {
        setName('');
        setHost('');
        setUsername('');
      }
      onDone(saved);
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  const title = credential ? t(M['api_credentials.form_rotate'], { name: credential.name }) : t(M['api_credentials.form_add']);
  return (
    <form className="mt-8 space-y-3" aria-label={title} onSubmit={submit(() => void save())}>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <Field label={t(M['api_credentials.name'])}>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" required />
      </Field>
      <Field label={t(M['api_credentials.host'])} hint={t(M['api_credentials.host_hint'])}>
        <Input value={host} onChange={(e) => setHost(e.target.value)} maxLength={260} autoComplete="off" spellCheck={false} required />
      </Field>
      <Field label={t(M['api_credentials.type'])}>
        <NiceSelect
          size="sm"
          value={type}
          onChange={(next) => setType(next as ApiCredential['type'])}
          aria-label={t(M['api_credentials.type'])}
          options={(['bearer', 'api_key', 'basic'] as const).map((value) => ({ value, label: t(TYPE_TEXT[value]) }))}
        />
      </Field>
      {type === 'bearer' ? (
        <Field label={t(M['api_credentials.token'])} hint={credential ? t(M['api_credentials.secret_keep']) : t(M['api_credentials.secret_hint'])}>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} maxLength={4096} autoComplete="off" spellCheck={false} />
        </Field>
      ) : null}
      {type === 'api_key' ? (
        <>
          <Field label={t(M['api_credentials.header'])}>
            <Input value={header} onChange={(e) => setHeader(e.target.value)} maxLength={64} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t(M['api_credentials.value'])} hint={credential ? t(M['api_credentials.secret_keep']) : t(M['api_credentials.secret_hint'])}>
            <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} maxLength={4096} autoComplete="off" spellCheck={false} />
          </Field>
        </>
      ) : null}
      {type === 'basic' ? (
        <>
          <Field label={t(M['api_credentials.username'])}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={256} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t(M['api_credentials.password'])} hint={credential ? t(M['api_credentials.secret_keep']) : t(M['api_credentials.secret_hint'])}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={4096} autoComplete="new-password" spellCheck={false} />
          </Field>
        </>
      ) : null}
      {hostChanged && secret === null ? <p className="text-[13px] text-muted-foreground">{t(M['api_credentials.host_needs_secret'])}</p> : null}
      {error ? <Alert variant="destructive" icon><AlertDescription>{error}</AlertDescription></Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !ready}>
          {credential ? t(M['api_credentials.save_rotate']) : t(M['api_credentials.save_add'])}
        </Button>
        {credential ? <Button type="button" variant="ghost" onClick={() => onDone(null)}>{t(M['api_credentials.cancel'])}</Button> : null}
      </div>
    </form>
  );
}
