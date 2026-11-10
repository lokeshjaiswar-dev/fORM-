import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { z } from 'zod';
import { FormRenderer, type SubmitPayload } from '@form/renderer';
import '@form/renderer/styles.css';
import { RuntimeFormVersionSchema, type RuntimeFormVersion } from '@form/schema';
import { API_BASE } from '@/edition/edition';
import { previewUploader } from '@/lib/preview';
import { BUILDER_LOCALE } from '@/i18n';
import { answerRows } from '@/persistence/answerRows';

const payloadSchema = z.object({
  slug: z.string(),
  formId: z.string(),
  version: RuntimeFormVersionSchema,
});

type Load = { status: 'loading' } | { status: 'missing' } | { status: 'error'; message: string } | { status: 'ready'; version: RuntimeFormVersion; slug: string };

export function PublicFillPage() {
  const { slug = '' } = useParams();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const startedAt = useMemo(() => new Date().toISOString(), []);

  useEffect(() => {
    let live = true;
    fetch(`${API_BASE}/v1/p/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (res.status === 404) return { status: 'missing' as const };
        if (!res.ok) return { status: 'error' as const, message: 'This form could not be loaded.' };
        const parsed = payloadSchema.safeParse(await res.json());
        if (!parsed.success) return { status: 'error' as const, message: 'This form could not be read.' };
        return { status: 'ready' as const, version: parsed.data.version, slug: parsed.data.slug };
      })
      .then((next) => {
        if (live) setLoad(next);
      })
      .catch(() => {
        if (live) setLoad({ status: 'error', message: 'This form could not be loaded.' });
      });
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
    <main className="min-h-svh bg-white text-foreground">
      <div className="mx-auto max-w-[720px] px-4 py-10">
        <FormRenderer
          version={load.version}
          mode="live"
          status={load.version.status}
          locale={BUILDER_LOCALE}
          uploader={previewUploader}
          session={{ startedAt, pageUrl: window.location.href }}
          onSubmit={async (payload: SubmitPayload) => {
            const res = await fetch(`${API_BASE}/v1/p/${encodeURIComponent(load.slug)}/submissions`, {
              method: 'POST',
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify({
                formVersionId: payload.formVersionId,
                answers: payload.answers,
                fields: answerRows(load.version.definition, payload.answers),
                locale: payload.locale,
              }),
            });
            if (!res.ok) throw new Error('submit failed');
          }}
        />
      </div>
    </main>
  );
}
