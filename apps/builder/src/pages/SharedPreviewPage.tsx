import { useEffect, useState } from 'react';
import { runtimeEdition } from '@form/config';
import { FormRenderer } from '@form/renderer';
import '@form/renderer/styles.css';
import type { IsoInstant, RuntimeFormVersion } from '@form/schema';
import { useEdition } from '@/edition/edition';
import { BUILDER_LOCALE } from '@/i18n';
import { previewUploader, previewVersion } from '@/lib/preview';
import { decodeShareFragment } from '@/lib/shareLink';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; version: RuntimeFormVersion };

/**
 * A form opened from a preview link (`/share#form=…`): the respondent view of the form carried in the link, with a
 * banner saying it is a preview. Nothing is stored and submitting only shows the ending: there is no server behind it.
 */
export function SharedPreviewPage() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [startedAt] = useState(() => new Date().toISOString() as IsoInstant);
  const edition = runtimeEdition(useEdition());

  useEffect(() => {
    let cancelled = false;
    void decodeShareFragment(window.location.hash, startedAt).then((opened) => {
      if (cancelled) return;
      if (!opened.ok) return setLoad({ status: 'error', message: opened.error });
      const built = previewVersion(opened.doc, { state: 'open' }, startedAt, edition);
      if (!built.ok) return setLoad({ status: 'error', message: built.issues[0]?.message ?? 'This form cannot be shown yet.' });
      setLoad({ status: 'ready', version: built.version });
    });
    return () => {
      cancelled = true;
    };
  }, [startedAt, edition]);

  if (load.status === 'loading') return <main className="min-h-svh bg-white" aria-busy="true" />;
  if (load.status === 'error') {
    return (
      <main className="mx-auto max-w-[640px] px-6 py-16 text-foreground">
        <h1 className="text-[28px] font-bold">This preview cannot be opened</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{load.message}</p>
      </main>
    );
  }
  return (
    <>
      <p role="note" className="bg-primary-faded px-4 py-2 text-center text-[13px] text-primary-text">
        Preview: you can fill this form to try it out, but answers are not saved.
      </p>
      <main className="fr-fill min-h-svh">
        <FormRenderer
          version={load.version}
          mode="preview"
          status={load.version.status}
          locale={BUILDER_LOCALE}
          uploader={previewUploader}
          session={{ startedAt, pageUrl: window.location.origin + window.location.pathname }}
          onSubmit={async () => undefined}
        />
      </main>
    </>
  );
}
