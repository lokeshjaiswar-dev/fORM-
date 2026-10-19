import { useMemo, useState } from 'react';
import { ExternalLink, Monitor } from 'lucide-react';
import { toast } from 'sonner';
import { defineMessages } from '@form/i18n';
import { FormRenderer, type SubmitPayload } from '@form/renderer';
import '@form/renderer/styles.css';
import type { FormDefinition, IsoInstant, RuntimeStatus } from '@form/schema';
import { BUILDER_LOCALE, t } from '@/i18n';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import { DeviceFrame, type PreviewDevice } from '@/components/preview/DeviceFrame';
import { previewStatus, previewUploader, previewVersion } from '@/lib/preview';
import { useDoc } from '@/state/documentStore';
import { useOpsStore } from '@/state/opsStore';

const M = defineMessages('builder', {
  'preview.desktop': 'Desktop',
  'preview.tablet': 'Tablet',
  'preview.mobile': 'Mobile',
  'preview.wrong_password': 'Incorrect password',
  'preview.refused': 'This form cannot be previewed yet.',
  'preview.redirect': 'After submit, respondents go to {url}',
  'preview.open_redirect': 'Open in a new tab',
});

const OPEN: RuntimeStatus = { state: 'open' };
const DEVICES = [
  ['desktop', M['preview.desktop'], Monitor],
  ['tablet', M['preview.tablet'], TabletGlyph],
  ['mobile', M['preview.mobile'], PhoneGlyph],
] as const;

/** The preview of the open form: the store's v2 definition and the status its local FormOps give. */
export function FormPreview() {
  const definition = useDoc((d) => d);
  const ops = useOpsStore();
  const status = useMemo(() => previewStatus(ops), [ops]);
  return <PreviewPane definition={definition} status={status} password={ops.password} />;
}

/**
 * The builder preview: a v2 draft compiled locally (compile + projectForRuntime, as publish would) and shown through
 * @form/renderer in a device frame. Submissions and files stay in the page; each submission is dispatched on window as
 * a `form-preview-submit` event so tooling and e2e tests can read the payload.
 */
export function PreviewPane({ definition, status = OPEN, password }: { definition: FormDefinition; status?: RuntimeStatus; password?: string | undefined }) {
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [unlocked, setUnlocked] = useState(false);
  const [redirect, setRedirect] = useState<string | null>(null);
  const [now] = useState(() => new Date().toISOString() as IsoInstant);
  const build = useMemo(() => previewVersion(definition, OPEN, now), [definition, now]);
  const session = useMemo(() => ({ startedAt: now, device }), [now, device]);
  const shown = status.state === 'password' && unlocked ? OPEN : status;

  const screen = build.ok ? (
    <FormRenderer
      version={build.version}
      mode="preview"
      status={shown}
      locale={BUILDER_LOCALE}
      uploader={previewUploader}
      session={session}
      onSubmit={(payload: SubmitPayload) => {
        window.dispatchEvent(new CustomEvent('form-preview-submit', { detail: payload }));
      }}
      onUnlock={(attempt) => {
        if (attempt === password) setUnlocked(true);
        else toast.error(t(M['preview.wrong_password']));
      }}
      onEvent={(event) => {
        /* The preview never leaves the builder: it shows where a respondent would go (BL-134). */
        if (event.type === 'redirect') setRedirect(event.url);
        if (event.type === 'restart') setRedirect(null);
      }}
    />
  ) : (
    <div className="p-6 text-left text-[14px]" role="alert">
      <p className="font-medium">{t(M['preview.refused'])}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-600">
        {build.issues.map((issue, i) => (
          <li key={i}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
      <div className="flex justify-center gap-0.5 py-1">
        {DEVICES.map(([id, label, Icon]) => (
          <Tooltip key={id} content={t(label)}>
            <button
              type="button"
              aria-label={t(label)}
              aria-pressed={device === id}
              onClick={() => setDevice(id)}
              className={cn(
                'flex size-8 items-center justify-center rounded-[4px]',
                device === id ? 'bg-zinc-100' : 'text-zinc-400 hover:bg-zinc-100',
              )}
            >
              <Icon className="size-4" />
            </button>
          </Tooltip>
        ))}
      </div>
      {redirect ? (
        <p role="status" className="mx-4 flex items-center justify-center gap-2 rounded-md bg-sky-50 px-3 py-2 text-[13px] text-sky-950">
          {t(M['preview.redirect'], { url: redirect })}
          <a href={redirect} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-medium underline">
            <ExternalLink className="size-3.5" /> {t(M['preview.open_redirect'])}
          </a>
        </p>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden px-4 py-4">
        <DeviceFrame device={device}>{screen}</DeviceFrame>
      </div>
    </div>
  );
}

function TabletGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="2" y="6" width="20" height="13" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="19.25" cy="12.5" r="0.85" fill="currentColor" />
    </svg>
  );
}

function PhoneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="7" y="2" width="10" height="20" rx="2.2" stroke="currentColor" strokeWidth="1.75" />
      <rect x="9.5" y="4" width="5" height="1.4" rx="0.7" fill="currentColor" />
    </svg>
  );
}
