import { useMemo, useState } from 'react';
import { Monitor } from 'lucide-react';
import { toast } from 'sonner';
import { FormRenderer, type SubmitPayload } from '@form/renderer';
import '@form/renderer/styles.css';
import type { FormDefinition, IsoInstant, Locale, RuntimeStatus } from '@form/schema';
import type { PreviewDevice } from '@/types/form';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import { DeviceFrame } from '@/components/preview/DeviceFrame';
import { previewUploader, previewVersion } from '@/lib/preview';

const LOCALE = 'en-IN' as Locale;
const OPEN: RuntimeStatus = { state: 'open' };
const DEVICES = [
  ['desktop', 'Desktop', Monitor],
  ['tablet', 'Tablet', TabletGlyph],
  ['mobile', 'Mobile', PhoneGlyph],
] as const;

/**
 * The builder preview: a v2 draft compiled locally (compile + projectForRuntime, as publish would) and shown through
 * @form/renderer in a device frame. Submissions and files stay in the page; each submission is dispatched on window as
 * a `form-preview-submit` event so tooling and e2e tests can read the payload.
 */
export function PreviewPane({ definition, status = OPEN, password }: { definition: FormDefinition; status?: RuntimeStatus; password?: string | undefined }) {
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [unlocked, setUnlocked] = useState(false);
  const [now] = useState(() => new Date().toISOString() as IsoInstant);
  const build = useMemo(() => previewVersion(definition, OPEN, now), [definition, now]);
  const session = useMemo(() => ({ startedAt: now, device }), [now, device]);
  const shown = status.state === 'password' && unlocked ? OPEN : status;

  const screen = build.ok ? (
    <FormRenderer
      version={build.version}
      mode="preview"
      status={shown}
      locale={LOCALE}
      uploader={previewUploader}
      session={session}
      onSubmit={(payload: SubmitPayload) => {
        window.dispatchEvent(new CustomEvent('form-preview-submit', { detail: payload }));
      }}
      onUnlock={(attempt) => {
        if (attempt === password) setUnlocked(true);
        else toast.error('Incorrect password');
      }}
      onEvent={(event) => {
        if (event.type === 'redirect') window.location.assign(event.url);
      }}
    />
  ) : (
    <div className="p-6 text-left text-[14px]" role="alert">
      <p className="font-medium">This form cannot be previewed yet.</p>
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
        {DEVICES.map(([id, name, Icon]) => (
          <Tooltip key={id} content={name}>
            <button
              type="button"
              aria-label={name}
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
