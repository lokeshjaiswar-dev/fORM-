import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { z } from 'zod';
import { FormRenderer, browserSession, type RendererSession, type SubmitPayload } from '@form/renderer';
import '@form/renderer/styles.css';
import { RuntimeFormVersionSchema, type BlockId, type IsoInstant, type RuntimeFormVersion } from '@form/schema';
import { API_BASE } from '@/edition/edition';
import { hydrateThemeImages } from '@/components/builder/design/uploads';
import { BUILDER_LOCALE } from '@/i18n';
import { answerRows } from '@/persistence/answerRows';
import { publicUploader } from '@/persistence/filesApi';

const payloadSchema = z.object({
  slug: z.string(),
  formId: z.string(),
  version: RuntimeFormVersionSchema,
  media: z.record(z.string(), z.string()).optional(),
});

type Load = { status: 'loading' } | { status: 'missing' } | { status: 'error'; message: string } | { status: 'ready'; version: RuntimeFormVersion; slug: string };

/*
 * A respondent is anonymous: these calls never carry the session cookie, even from a browser that is signed in to the
 * builder (`credentials: 'omit'`), so the API's CSRF guard, which only looks at requests riding on that cookie, has
 * nothing to refuse and a form's author can fill their own live form.
 */
export function PublicFillPage() {
  const { slug = '' } = useParams();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // One session per page view: the clock, plus what the browser knows (URL/UTM parameters, referrer, user agent) for
  // context fields. The renderer never reads `window` itself, so the host passes it in.
  const session = useMemo<RendererSession>(() => ({ startedAt: new Date().toISOString() as IsoInstant, ...browserSession() }), []);
  const uploader = useMemo(() => publicUploader(slug), [slug]);

  useEffect(() => {
    let live = true;
    const loadOnce = async (): Promise<Load> => {
      const res = await fetch(`${API_BASE}/v1/p/${encodeURIComponent(slug)}`, { credentials: 'omit', headers: { accept: 'application/json' } });
      if (res.status === 404) return { status: 'missing' };
      if (!res.ok) return { status: 'error', message: 'This form could not be loaded.' };
      const parsed = payloadSchema.safeParse(await res.json());
      if (!parsed.success) return { status: 'error', message: 'This form could not be read.' };
      hydrateThemeImages(parsed.data.media);
      return { status: 'ready', version: parsed.data.version, slug: parsed.data.slug };
    };
    const open = async () => {
      let last: Load = { status: 'error', message: 'This form could not be loaded.' };
      for (let attempt = 0; attempt < 4 && live; attempt++) {
        try {
          last = await loadOnce();
          if (last.status === 'ready' || last.status === 'missing') break;
        } catch {
          last = { status: 'error', message: 'This form could not be loaded.' };
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
      if (live) setLoad(last);
    };
    void open();
    return () => {
      live = false;
    };
  }, [slug]);

  if (load.status === 'loading') return <main className="min-h-svh bg-white" aria-busy="true" />;
  if (load.status !== 'ready') {
    return (
      <main className="mx-auto max-w-[640px] px-6 py-16 text-foreground">
        <h1 className="text-[28px] font-bold">{load.status === 'missing' ? 'Form not found' : 'This form cannot be opened'}</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{load.status === 'missing' ? 'This link is not a published form.' : load.message}</p>
      </main>
    );
  }

  return (
    <main className="fr-fill min-h-svh">
      <FormRenderer
        version={load.version}
        mode="live"
        status={load.version.status}
        locale={BUILDER_LOCALE}
        uploader={uploader}
        session={session}
        onSubmit={async (payload: SubmitPayload) => {
          const res = await fetch(`${API_BASE}/v1/p/${encodeURIComponent(load.slug)}/submissions`, {
            method: 'POST',
            credentials: 'omit',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({
              formVersionId: payload.formVersionId,
              answers: payload.answers,
              fields: answerRows(load.version.definition, payload.answers),
              locale: payload.locale,
            }),
          });
          // The server re-checks every answer against the live version: show what it refused next to the fields.
          if (res.status === 400) {
            const problem = (await res.json().catch(() => null)) as { errors?: Array<{ path?: unknown; message?: unknown }> } | null;
            const errors = (problem?.errors ?? []).flatMap((e) =>
              typeof e.path === 'string' && e.path && typeof e.message === 'string'
                ? [{ blockId: e.path.split('.')[0] as BlockId, code: 'invalid_format' as const, message: e.message }]
                : [],
            );
            if (errors.length > 0) return { ok: false, kind: 'invalid', status: 422, errors };
          }
          if (res.status === 409) return { ok: false, kind: 'version_superseded' };
          if (!res.ok) throw new Error('submit failed');
        }}
      />
    </main>
  );
}
